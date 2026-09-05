/**
 * User type definitions for NATIVE diabetes management platform
 * @module types/user
 */

import type {
  PatientConstants,
  InsulinTimingGuideline,
  TimeOfDayFactor,
  DiseaseFactor,
  MedicationFactor
} from './constants.types';

// Re-export the types for convenience
export type {
  PatientConstants,
  InsulinTimingGuideline,
  TimeOfDayFactor,
  DiseaseFactor,
  MedicationFactor
};

/**
 * User role types in the system
 */
export type UserType = 'patient' | 'doctor' | 'admin';

/**
 * Base user interface with common fields
 */
export interface User {
  id: string;
  email: string;
  username: string;
  userType: UserType;
  firstName?: string;
  lastName?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Patient-specific user interface extending base User
 */
export interface Patient extends User {
  userType: 'patient';
  dateOfBirth?: string;
  diabetesType?: 'type_1_diabetes' | 'type_2_diabetes' | 'gestational_diabetes';
  diagnosisDate?: string;
  assignedDoctorId?: string;
  patientConstants?: PatientConstants;
  medications?: string[];
  conditions?: string[];
}

/**
 * Doctor-specific user interface extending base User
 */
export interface Doctor extends User {
  userType: 'doctor';
  specialization?: string;
  licenseNumber?: string;
  patientIds?: string[];
}
