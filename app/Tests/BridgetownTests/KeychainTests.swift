import Foundation
import Security
import Testing
@testable import Bridgetown

/// The real Keychain stays out of it: reads are checked by status, saves in memory.
@MainActor @Suite(.serialized) struct KeychainTests {
    @Test func aRefusedReadIsNotAnEmptyKeychain() {
        #expect(Keychain.stored(errSecItemNotFound, nil) == [:])
        #expect(Keychain.stored(errSecSuccess, Data(#"{"slack-user-token":"xoxp-1"}"#.utf8)) == ["slack-user-token": "xoxp-1"])
        for refused in [errSecUserCanceled, errSecAuthFailed, errSecInteractionNotAllowed] {
            #expect(Keychain.stored(refused, nil) == nil)
        }
    }

    /// Saving one secret keeps the other, and an empty field removes its own.
    @Test func savingKeepsWhatItDoesntChange() {
        Keychain.inMemory = ["slack-user-token": "xoxp-1", "typesafe-api-key": "ts_1"]
        // Never back to nil: a test launching a daemon at the same time would read the real Keychain.
        defer { Keychain.inMemory = [:] }
        #expect(Keychain.save([.slackUserToken: " xoxp-2\n"]))
        #expect(Keychain.secrets() == [.slackUserToken: "xoxp-2", .typesafeAPIKey: "ts_1"])
        #expect(Keychain.save([.typesafeAPIKey: ""]))
        #expect(Keychain.secrets() == [.slackUserToken: "xoxp-2"])
    }
}
