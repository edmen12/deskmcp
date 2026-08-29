import Foundation

public enum SupervisorDecision: Equatable {
    case none
    case start
    case stopAndBackoff(TimeInterval)
}

public struct ServiceSupervisorState: Equatable {
    public static let defaultRetryDelays: [TimeInterval] = [2, 5, 10, 30]

    public let watchdog: TimeInterval
    public let retryDelays: [TimeInterval]
    public private(set) var unhealthySince: TimeInterval?
    public private(set) var retryAttempt = 0
    public private(set) var nextRetryAt: TimeInterval?

    public init(
        watchdog: TimeInterval = 45,
        retryDelays: [TimeInterval] = [2, 5, 10, 30]
    ) {
        precondition(watchdog > 0)
        precondition(!retryDelays.isEmpty && retryDelays.allSatisfy { $0 > 0 })
        self.watchdog = watchdog
        self.retryDelays = retryDelays
    }

    public mutating func evaluate(
        shouldRun: Bool,
        isRunning: Bool,
        isReady: Bool,
        now: TimeInterval
    ) -> SupervisorDecision {
        if isReady {
            reset()
            return .none
        }
        if !shouldRun {
            reset()
            return .none
        }
        if isRunning {
            if unhealthySince == nil {
                unhealthySince = now
                return .none
            }
            guard now - (unhealthySince ?? now) >= watchdog else { return .none }
            let delay = recordFailure(now: now)
            return .stopAndBackoff(delay)
        }

        unhealthySince = nil
        if let nextRetryAt {
            guard now >= nextRetryAt else { return .none }
            self.nextRetryAt = nil
        }
        return .start
    }

    @discardableResult
    public mutating func recordFailure(now: TimeInterval) -> TimeInterval {
        let index = min(retryAttempt, retryDelays.count - 1)
        let delay = retryDelays[index]
        retryAttempt = min(retryAttempt + 1, retryDelays.count)
        nextRetryAt = now + delay
        unhealthySince = nil
        return delay
    }

    public mutating func reset() {
        unhealthySince = nil
        retryAttempt = 0
        nextRetryAt = nil
    }
}
