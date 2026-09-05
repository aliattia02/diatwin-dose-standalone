"""
migrate_timezone_offset.py - Database Migration Script
============================================================================
Adds timezone_offset_minutes field to all existing patient constants.

🎯 PURPOSE:
This migration ensures all existing patients have the timezone_offset_minutes
field in their constants, defaulting to 0 (UTC) for safety.

⚠️ IMPORTANT:
After migration, patients should update their timezone via frontend settings
to match their actual location. The frontend auto-detects timezone on login.

USAGE:
    python migrate_timezone_offset.py [--dry-run] [--verbose]

OPTIONS:
    --dry-run    Show changes without applying them
    --verbose    Show detailed progress

Author: DiaTwin Team
Version: 1.0 (Timezone Fix Migration)
============================================================================
"""

import sys
import argparse
from datetime import datetime
from pymongo import MongoClient
from bson import ObjectId
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def migrate_timezone_offset(dry_run=False, verbose=False):
    """
    Add timezone_offset_minutes to all patient constants.
    
    Args:
        dry_run (bool): If True, show changes without applying
        verbose (bool): If True, show detailed progress
        
    Returns:
        dict: Migration statistics
    """
    # Connect to database
    try:
        # Update with your MongoDB connection string
        client = MongoClient('mongodb://localhost:27017/')
        db = client['diatwin']  # Update with your database name
        logger.info("✅ Connected to database")
    except Exception as e:
        logger.error(f"❌ Failed to connect to database: {e}")
        return None

    stats = {
        'total_patients': 0,
        'already_migrated': 0,
        'migrated': 0,
        'errors': 0,
        'timestamp': datetime.utcnow().isoformat()
    }

    try:
        # Find all patients
        patients = list(db.users.find({'user_type': 'patient'}))
        stats['total_patients'] = len(patients)
        
        logger.info(f"\n📊 Found {stats['total_patients']} patients to check")
        logger.info(f"🔧 Mode: {'DRY RUN (no changes)' if dry_run else 'LIVE MIGRATION'}\n")

        for patient in patients:
            patient_id = str(patient['_id'])
            
            # Get patient constants from constants collection
            constants_doc = db.constants.find_one({'user_id': patient_id})
            
            if not constants_doc:
                if verbose:
                    logger.warning(f"⚠️  Patient {patient_id} has no constants document")
                continue

            # Check if already migrated
            if 'timezone_offset_minutes' in constants_doc:
                stats['already_migrated'] += 1
                if verbose:
                    current_offset = constants_doc['timezone_offset_minutes']
                    logger.info(f"✓ Patient {patient_id[:8]}... already has timezone_offset_minutes = {current_offset}")
                continue

            # Prepare update
            update = {
                '$set': {
                    'timezone_offset_minutes': 0,  # Default to UTC
                    'updated_at': datetime.utcnow()
                }
            }

            # Apply or preview
            if dry_run:
                logger.info(f"[DRY RUN] Would set timezone_offset_minutes=0 for patient {patient_id[:8]}...")
                stats['migrated'] += 1
            else:
                try:
                    result = db.constants.update_one(
                        {'_id': constants_doc['_id']},
                        update
                    )
                    
                    if result.modified_count > 0:
                        stats['migrated'] += 1
                        logger.info(f"✅ Migrated patient {patient_id[:8]}... (timezone_offset_minutes = 0)")
                    else:
                        logger.warning(f"⚠️  No changes for patient {patient_id[:8]}...")
                        
                except Exception as e:
                    stats['errors'] += 1
                    logger.error(f"❌ Error migrating patient {patient_id[:8]}...: {e}")

    except Exception as e:
        logger.error(f"❌ Migration failed: {e}")
        return None
    finally:
        client.close()

    # Print summary
    print("\n" + "="*70)
    print("MIGRATION SUMMARY")
    print("="*70)
    print(f"Total patients:        {stats['total_patients']}")
    print(f"Already migrated:      {stats['already_migrated']}")
    print(f"Newly migrated:        {stats['migrated']}")
    print(f"Errors:                {stats['errors']}")
    print(f"Timestamp:             {stats['timestamp']}")
    print("="*70)
    
    if dry_run:
        print("\n⚠️  DRY RUN MODE - No changes were made to the database")
        print("Run without --dry-run to apply changes\n")
    else:
        print("\n✅ Migration complete!")
        print("\n📋 NEXT STEPS:")
        print("1. Deploy updated backend code (constants.py, pharmacodynamics.py, cumulative_effects_routes.py)")
        print("2. Deploy updated frontend code (TimeManager.js, BloodSugarDataContext)")
        print("3. Test timezone alignment with comparison panel")
        print("4. Patients will auto-update their timezone on next login\n")

    return stats


def main():
    """Main entry point for migration script"""
    parser = argparse.ArgumentParser(
        description='Migrate patient constants to include timezone_offset_minutes',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Preview changes without applying
  python migrate_timezone_offset.py --dry-run --verbose
  
  # Run migration
  python migrate_timezone_offset.py
  
  # Run with detailed progress
  python migrate_timezone_offset.py --verbose
        """
    )
    
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Show changes without applying them'
    )
    
    parser.add_argument(
        '--verbose', '-v',
        action='store_true',
        help='Show detailed progress for each patient'
    )

    args = parser.parse_args()

    print("\n" + "="*70)
    print("TIMEZONE OFFSET MIGRATION")
    print("="*70)
    print("This script adds timezone_offset_minutes to all patient constants")
    print("Default value: 0 (UTC)")
    print("="*70 + "\n")

    if not args.dry_run:
        confirm = input("⚠️  This will modify the database. Continue? (yes/no): ")
        if confirm.lower() != 'yes':
            print("❌ Migration cancelled")
            return 1

    stats = migrate_timezone_offset(dry_run=args.dry_run, verbose=args.verbose)
    
    if stats is None:
        return 1
    
    return 0


if __name__ == '__main__':
    sys.exit(main())
