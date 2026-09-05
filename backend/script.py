from config import app, create_app_config
from constants import ConstantConfig

# 🔴 THIS is the missing step
app, mongo, logger = create_app_config(app)

with app.app_context():
    correct_timing = ConstantConfig().insulin_timing_guidelines

    result = mongo.db.users.update_many(
        {},
        {"$set": {"patient_constants.insulin_timing_guidelines": correct_timing}}
    )

    print(f"Matched: {result.matched_count}, Updated: {result.modified_count}")