/**
 * Generic API hook for making API calls with loading/error states
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { isNetworkError, isAuthError } from '@/services/api/client';
import { useOfflineStore } from '@/store/offline.store';

export interface ApiState<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
}

export interface UseApiOptions {
  /** Whether to cache the result */
  cache?: boolean;
  /** Cache key for storing result */
  cacheKey?: string;
  /** Whether to show loading state */
  showLoading?: boolean;
  /** Initial data value */
  initialData?: unknown;
}

export interface UseApiResult<T, P extends unknown[]> extends ApiState<T> {
  /** Execute the API call */
  execute: (...params: P) => Promise<T | null>;
  /** Reset state to initial */
  reset: () => void;
  /** Set data manually */
  setData: (data: T | null) => void;
  /** Clear error */
  clearError: () => void;
}

/**
 * Hook for making API calls with loading/error state management
 */
export function useApi<T, P extends unknown[] = []>(
  apiFunction: (...params: P) => Promise<T>,
  options: UseApiOptions = {}
): UseApiResult<T, P> {
  const { showLoading = true, initialData = null } = options;
  
  const [state, setState] = useState<ApiState<T>>({
    data: initialData as T | null,
    isLoading: false,
    error: null,
  });
  
  const setOnline = useOfflineStore((s) => s.setOnline);
  const isMounted = useRef(true);
  
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const execute = useCallback(async (...params: P): Promise<T | null> => {
    if (showLoading) {
      setState((prev) => ({ ...prev, isLoading: true, error: null }));
    }
    
    try {
      const result = await apiFunction(...params);
      
      if (isMounted.current) {
        setState({ data: result, isLoading: false, error: null });
      }
      
      return result;
    } catch (error) {
      if (isNetworkError(error)) {
        setOnline(false);
      }
      
      const errorMessage = error instanceof Error ? error.message : 'An error occurred';
      
      if (isMounted.current) {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: errorMessage,
        }));
      }
      
      return null;
    }
  }, [apiFunction, showLoading, setOnline]);

  const reset = useCallback(() => {
    setState({
      data: initialData as T | null,
      isLoading: false,
      error: null,
    });
  }, [initialData]);

  const setData = useCallback((data: T | null) => {
    setState((prev) => ({ ...prev, data }));
  }, []);

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  return {
    ...state,
    execute,
    reset,
    setData,
    clearError,
  };
}

/**
 * Hook for API calls that execute immediately on mount
 */
export function useApiEffect<T>(
  apiFunction: () => Promise<T>,
  deps: React.DependencyList = [],
  options: UseApiOptions = {}
): ApiState<T> & { refetch: () => Promise<T | null> } {
  const { execute, ...state } = useApi(apiFunction, options);
  
  useEffect(() => {
    execute();
  }, deps);
  
  return { ...state, refetch: execute };
}

export default useApi;
