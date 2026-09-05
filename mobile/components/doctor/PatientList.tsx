/**
 * PatientList Component
 * Displays a searchable list of authorized patients for doctors
 */

import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
} from 'react-native';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import type { DoctorPatient } from '@/services/api/doctor';

interface PatientListProps {
  patients: DoctorPatient[];
  selectedPatient: DoctorPatient | null;
  onSelectPatient: (patient: DoctorPatient) => void;
  isLoading?: boolean;
}

export const PatientList: React.FC<PatientListProps> = ({
  patients,
  selectedPatient,
  onSelectPatient,
  isLoading = false,
}) => {
  const [searchTerm, setSearchTerm] = useState('');

  const filteredPatients = useMemo(() => {
    if (!searchTerm.trim()) {
      return patients;
    }
    const term = searchTerm.toLowerCase();
    return patients.filter(
      (patient) =>
        patient.firstName.toLowerCase().includes(term) ||
        patient.lastName.toLowerCase().includes(term) ||
        patient.email.toLowerCase().includes(term)
    );
  }, [patients, searchTerm]);

  const renderPatientItem = ({ item }: { item: DoctorPatient }) => {
    const isSelected = selectedPatient?.id === item.id;
    const fullName = `${item.firstName} ${item.lastName}`;

    return (
      <TouchableOpacity
        style={[styles.patientItem, isSelected && styles.patientItemSelected]}
        onPress={() => onSelectPatient(item)}
        activeOpacity={0.7}
      >
        <View style={styles.patientAvatar}>
          <Text style={styles.patientAvatarText}>
            {item.firstName.charAt(0).toUpperCase()}
            {item.lastName.charAt(0).toUpperCase()}
          </Text>
        </View>
        <View style={styles.patientInfo}>
          <Text style={[styles.patientName, isSelected && styles.patientNameSelected]}>
            {fullName}
          </Text>
          <Text style={styles.patientEmail}>{item.email}</Text>
          {item.activeConditions && item.activeConditions.length > 0 && (
            <View style={styles.conditionsContainer}>
              {item.activeConditions.slice(0, 2).map((condition, index) => (
                <View key={index} style={styles.conditionBadge}>
                  <Text style={styles.conditionText}>{condition}</Text>
                </View>
              ))}
              {item.activeConditions.length > 2 && (
                <Text style={styles.moreConditions}>
                  +{item.activeConditions.length - 2} more
                </Text>
              )}
            </View>
          )}
        </View>
        <Text style={styles.chevron}>›</Text>
      </TouchableOpacity>
    );
  };

  if (isLoading) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>Loading patients...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>My Patients</Text>
        <Text style={styles.count}>
          {patients.length} authorized
        </Text>
      </View>

      {patients.length > 0 && (
        <View style={styles.searchContainer}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            placeholder="Search patients..."
            placeholderTextColor={colors.text.disabled}
            value={searchTerm}
            onChangeText={setSearchTerm}
          />
          {searchTerm.length > 0 && (
            <TouchableOpacity onPress={() => setSearchTerm('')}>
              <Text style={styles.clearButton}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {patients.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyIcon}>👥</Text>
          <Text style={styles.emptyTitle}>No Authorized Patients</Text>
          <Text style={styles.emptyText}>
            Patients must authorize you to view their data.
            Ask them to add you from their dashboard.
          </Text>
        </View>
      ) : filteredPatients.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>No patients match your search</Text>
        </View>
      ) : (
        <FlatList
          data={filteredPatients}
          keyExtractor={(item) => item.id}
          renderItem={renderPatientItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    ...typography.h3,
    color: colors.text.primary,
  },
  count: {
    ...typography.caption,
    color: colors.text.secondary,
    backgroundColor: colors.surfaceVariant,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceVariant,
    marginHorizontal: spacing.md,
    marginVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.md,
    minHeight: 44,
  },
  searchIcon: {
    fontSize: 16,
    marginRight: spacing.sm,
  },
  searchInput: {
    flex: 1,
    ...typography.body,
    color: colors.text.primary,
  },
  clearButton: {
    fontSize: 16,
    color: colors.text.secondary,
    paddingLeft: spacing.sm,
  },
  listContent: {
    paddingBottom: spacing.lg,
  },
  patientItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surface,
  },
  patientItemSelected: {
    backgroundColor: colors.primary + '15',
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
  },
  patientAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  patientAvatarText: {
    ...typography.body,
    color: colors.text.inverse,
    fontWeight: '600',
  },
  patientInfo: {
    flex: 1,
  },
  patientName: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '600',
  },
  patientNameSelected: {
    color: colors.primary,
  },
  patientEmail: {
    ...typography.small,
    color: colors.text.secondary,
    marginTop: 2,
  },
  conditionsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: spacing.xs,
  },
  conditionBadge: {
    backgroundColor: colors.warning + '20',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
    marginRight: spacing.xs,
    marginBottom: spacing.xs,
  },
  conditionText: {
    ...typography.small,
    color: colors.warning,
    fontSize: 10,
  },
  moreConditions: {
    ...typography.small,
    color: colors.text.secondary,
    fontSize: 10,
  },
  chevron: {
    fontSize: 24,
    color: colors.text.disabled,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: spacing.md,
  },
  emptyTitle: {
    ...typography.h3,
    color: colors.text.primary,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  emptyText: {
    ...typography.body,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 22,
  },
});

export default PatientList;