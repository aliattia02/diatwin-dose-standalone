"""Harness sanity check — proves the fixtures work before anything relies on them."""


def test_app_boots(flask_app):
    assert flask_app.config["TESTING"] is True


def test_health_endpoint(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.get_json() == {"status": "ok"}


def test_database_is_isolated_per_test(db, patient):
    assert db.users.count_documents({}) == 1


def test_database_was_cleaned(db):
    assert db.users.count_documents({}) == 0


def test_token_authenticates(client, patient, auth):
    r = client.get("/api/patient/constants", headers=auth(patient))
    assert r.status_code != 401


def test_seed_writes_records(db, patient, seed):
    info = seed(patient)
    assert db.blood_sugar.count_documents({}) == info["readings"]
    assert db.meals.count_documents({}) == 1
    assert db.medication_logs.count_documents({}) == 1
