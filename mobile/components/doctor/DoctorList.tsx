/**
 * Doctor List Component - Shows available and authorized doctors
 * Location: mobile/components/doctor/DoctorList.tsx
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, FlatList } from 'react-native';
import { Card } from '@/components/ui';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import type { Doctor, AuthorizedDoctor } from '@/services/api/doctor-management';

interface DoctorListProps {
  doctors: Doctor[];
  authorizedDoctorIds: string[];
  onAuthorize: (doctorId: string) => void;
  onRevoke: (doctorId: string) => void;
  isLoading?: boolean;
}

export const DoctorList: React.FC<DoctorListProps> = ({
  doctors,
  authorizedDoctorIds,
  onAuthorize,
  onRevoke,
  isLoading = false,
}) => {
  const [searchTerm, setSearchTerm] = useState('');

  const filteredDoctors = doctors.filter(doctor => {
    const fullName = `${doctor.firstName} ${doctor.lastName}`.toLowerCase();
    const search = searchTerm.toLowerCase();
    return (
      fullName.includes(search) ||
      doctor.email.toLowerCase().includes(search)
    );
  });

  const renderDoctorItem = ({ item }: { item: Doctor }) => {
    const isAuthorized = authorizedDoctorIds.includes(item.id);

    return (
      <Card
        variant="outlined"
        padding="medium"
        style={[
          styles.doctorCard,
          isAuthorized && styles.authorizedCard,
        ]}
      >
        <View style={styles.doctorInfo}>
          <View style={styles.doctorAvatar}>
            <Text style={styles.avatarText}>
              {item.firstName[0]}{item.lastName[0]}
            </Text>
          </View>
          <View style={styles.doctorDetails}>
            <Text style={styles.doctorName}>
              Dr. {item.firstName} {item.lastName}
            </Text>
            <Text style={styles.doctorEmail}>{item.email}</Text>
            {isAuthorized && (
              <View style={styles.authorizedBadge}>
                <Text style={styles.authorizedText}>✓ Authorized</Text>
              </View>
            )}
          </View>
        </View>
        <TouchableOpacity
          style={[
            styles.actionButton,
            isAuthorized ? styles.revokeButton : styles.authorizeButton,
          ]}
          onPress={() => isAuthorized ? onRevoke(item.id) : onAuthorize(item.id)}
          disabled={isLoading}
        >
          <Text
            style={[
              styles.actionButtonText,
              isAuthorized ? styles.revokeButtonText : styles.authorizeButtonText,
            ]}
          >
            {isAuthorized ? 'Revoke' : 'Authorize'}
          </Text>
        </TouchableOpacity>
      </Card>
    );
  };

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.searchInput}
        placeholder="Search doctors by name or email..."
        placeholderTextColor={colors.text.disabled}
        value={searchTerm}
        onChangeText={setSearchTerm}
      />
      
      {filteredDoctors.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyStateIcon}>👨‍⚕️</Text>
          <Text style={styles.emptyStateText}>
            {searchTerm ? 'No doctors found' : 'No doctors available'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filteredDoctors}
          renderItem={renderDoctorItem}
          keyExtractor={(item) => item.id}
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
  searchInput: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...typography.body,
    color: colors.text.primary,
  },
  listContent: {
    paddingBottom: spacing.md,
  },
  doctorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  authorizedCard: {
    borderColor: colors.success,
    borderWidth: 2,
  },
  doctorInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: spacing.sm,
  },
  doctorAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  avatarText: {
    ...typography.body,
    color: colors.text.inverse,
    fontWeight: 'bold',
  },
  doctorDetails: {
    flex: 1,
  },
  doctorName: {
    ...typography.body,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: 2,
  },
  doctorEmail: {
    ...typography.small,
    color: colors.text.secondary,
  },
  authorizedBadge: {
    marginTop: 4,
    alignSelf: 'flex-start',
  },
  authorizedText: {
    ...typography.caption,
    color: colors.success,
    fontWeight: '600',
  },
  actionButton: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.sm,
    minWidth: 90,
    alignItems: 'center',
  },
  authorizeButton: {
    backgroundColor: colors.primary,
  },
  revokeButton: {
    backgroundColor: colors.danger,
  },
  actionButtonText: {
    ...typography.small,
    fontWeight: '600',
  },
  authorizeButtonText: {
    color: colors.text.inverse,
  },
  revokeButtonText: {
    color: colors.text.inverse,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl * 2,
  },
  emptyStateIcon: {
    fontSize: 48,
    marginBottom: spacing.md,
  },
  emptyStateText: {
    ...typography.body,
    color: colors.text.secondary,
  },
});