import XCTest
@testable import DeskMCPCore

final class RuntimeSupervisorPolicyTests: XCTestCase {
    func testWatchdogStopsAfterThresholdAndSchedulesInitialBackoff() {
        var state = ServiceSupervisorState(watchdog: 45)

        XCTAssertEqual(
            state.evaluate(shouldRun: true, isRunning: true, isReady: false, now: 100),
            .none
        )
        XCTAssertEqual(
            state.evaluate(shouldRun: true, isRunning: true, isReady: false, now: 144.9),
            .none
        )
        XCTAssertEqual(
            state.evaluate(shouldRun: true, isRunning: true, isReady: false, now: 145),
            .stopAndBackoff(2)
        )
        XCTAssertEqual(state.nextRetryAt, 147)
    }

    func testRetryWaitsUntilDeadline() {
        var state = ServiceSupervisorState()
        _ = state.recordFailure(now: 10)

        XCTAssertEqual(
            state.evaluate(shouldRun: true, isRunning: false, isReady: false, now: 11.9),
            .none
        )
        XCTAssertEqual(
            state.evaluate(shouldRun: true, isRunning: false, isReady: false, now: 12),
            .start
        )
    }

    func testBackoffProgressionCapsAtThirtySeconds() {
        var state = ServiceSupervisorState()
        XCTAssertEqual(state.recordFailure(now: 0), 2)
        XCTAssertEqual(state.recordFailure(now: 10), 5)
        XCTAssertEqual(state.recordFailure(now: 20), 10)
        XCTAssertEqual(state.recordFailure(now: 30), 30)
        XCTAssertEqual(state.recordFailure(now: 40), 30)
        XCTAssertEqual(state.nextRetryAt, 70)
    }

    func testReadyResetsRetryState() {
        var state = ServiceSupervisorState()
        _ = state.recordFailure(now: 10)

        XCTAssertEqual(
            state.evaluate(shouldRun: true, isRunning: true, isReady: true, now: 11),
            .none
        )
        XCTAssertEqual(state.retryAttempt, 0)
        XCTAssertNil(state.nextRetryAt)
        XCTAssertNil(state.unhealthySince)
    }

    func testDisabledServiceClearsBackoffAndDoesNotStart() {
        var state = ServiceSupervisorState()
        _ = state.recordFailure(now: 10)

        XCTAssertEqual(
            state.evaluate(shouldRun: false, isRunning: false, isReady: false, now: 20),
            .none
        )
        XCTAssertEqual(state.retryAttempt, 0)
        XCTAssertNil(state.nextRetryAt)
        XCTAssertNil(state.unhealthySince)
    }
}
