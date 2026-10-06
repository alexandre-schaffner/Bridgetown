import Foundation
import Testing
@testable import Bridgetown

@MainActor @Suite struct E2EHarnessTests {
    /// Runs in two worktrees at once must not share the mock's root or the defaults that
    /// hold the telemetry tab; runs in one checkout keep both, so its shots compare.
    @Test func eachCheckoutRunsApart() {
        let first = E2EHarness.checkout(of: URL(fileURLWithPath: "/w/a/.context/e2e/20261006-072709"))
        #expect(first == E2EHarness.checkout(of: URL(fileURLWithPath: "/w/a/.context/e2e/20261006-073122")))
        #expect(first != E2EHarness.checkout(of: URL(fileURLWithPath: "/w/b/.context/e2e/20261006-072709")))
    }
}
