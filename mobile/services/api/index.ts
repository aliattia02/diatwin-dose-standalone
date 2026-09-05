/**
 * API Services Index - Central export point
 * Location: mobile/services/api/index.ts
 */

export { default as apiClient, isNetworkError, isAuthError } from './client';
export { default as API } from './endpoints';
export * from './auth';
export * from './meals';
export * from './glucose';
export * from './insulin';
export * from './food';
export * from './doctor';
export * from './doctor-management';
export * from './calculations';
export * from './patient';
export * from './mob';
export * from './activities';
export * from './libre';           // LibreLinkUp CGM integration