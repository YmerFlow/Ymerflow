#!/usr/bin/env python
"""
Quick smoke test to verify LogManager implementation is syntactically correct.
This verifies imports and basic functionality without database access.
"""

from backend.services.log_manager import LogManager, LogRetrievalState
from backend.models.process import ProcessVersion, Process


def test_log_manager_smoke():
    """Smoke test for LogManager - verify basic functionality"""

    print("🧪 LogManager Smoke Test")
    print("=" * 60)

    # Test 1: Imports
    print("\n1. Testing imports...")
    print("   ✓ LogManager imported")
    print("   ✓ LogRetrievalState imported")
    print("   ✓ ProcessVersion imported")
    print("   ✓ Process imported")

    # Test 2: LogManager instantiation
    print("\n2. Testing LogManager instantiation...")
    log_manager = LogManager("test-process-id", 1)
    assert log_manager.process_id == "test-process-id"
    assert log_manager.version == 1
    assert log_manager.stream_task is None
    assert len(log_manager.events_retrieved) == 0
    print("   ✓ LogManager created successfully")

    # Test 3: LogRetrievalState enum values
    print("\n3. Testing LogRetrievalState values...")
    states = [
        LogRetrievalState.NOT_STARTED,
        LogRetrievalState.STREAMING,
        LogRetrievalState.STREAM_ENDED,
        LogRetrievalState.HISTORICAL,
        LogRetrievalState.COMPLETE,
        LogRetrievalState.UNAVAILABLE,
    ]
    for state in states:
        assert isinstance(state, str)
        print(f"   ✓ {state}")

    # Test 4: Event deduplication
    print("\n4. Testing event deduplication...")
    event1 = "[Warning] Test event"
    event2 = "[Warning] Test event"
    event3 = "[Warning] Different event"

    id1 = log_manager._event_id(event1)
    id2 = log_manager._event_id(event2)
    id3 = log_manager._event_id(event3)

    assert id1 == id2, "Same events should have same ID"
    assert id1 != id3, "Different events should have different IDs"
    print("   ✓ Event deduplication working")

    # Test 5: Checkpoint logic
    print("\n5. Testing checkpoint logic...")
    log_manager._checkpoint_counter = 0
    assert not log_manager._should_checkpoint(), "Should not checkpoint at 0 logs"

    log_manager._checkpoint_counter = 10
    assert log_manager._should_checkpoint(), "Should checkpoint at 10 logs"
    print("   ✓ Checkpoint logic working")

    # Test 6: Verify ProcessVersion has new fields
    print("\n6. Testing ProcessVersion model fields...")
    # Check that the attributes exist (will fail if model definition is wrong)
    assert hasattr(ProcessVersion, 'log_retrieval_state')
    assert hasattr(ProcessVersion, 'log_last_timestamp')
    assert hasattr(ProcessVersion, 'log_stream_position')
    assert hasattr(ProcessVersion, 'log_checkpoint')
    print("   ✓ All log tracking fields defined in model")

    # Test 7: Verify monitor_job signature
    print("\n7. Testing ProcessVersion.monitor_job signature...")
    import inspect
    sig = inspect.signature(ProcessVersion.monitor_job)
    params = list(sig.parameters.keys())
    assert 'process_id' in params
    assert 'version' in params
    print("   ✓ monitor_job has correct signature")

    print("\n" + "=" * 60)
    print("✅ All smoke tests passed!")
    print("\nThe LogManager implementation is syntactically correct.")
    print("\nDatabase migration verification:")
    print("  Run: sqlite3 backend/ymerflow.db \".schema process_versions\"")
    print("  Confirm: log_retrieval_state, log_last_timestamp,")
    print("           log_stream_position, log_checkpoint columns exist")
    print("\nNext steps:")
    print("  1. Restart the backend server")
    print("  2. Create a test process and verify logs are retrieved")
    print("  3. Test backend restart during process execution")
    print("  4. Verify no duplicate logs appear")


if __name__ == "__main__":
    test_log_manager_smoke()
