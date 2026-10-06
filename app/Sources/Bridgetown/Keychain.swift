import Foundation
import Security

/// Bridgetown's secrets, kept in one generic-password item (service `xyz.merkl.bridgetown`,
/// account `credentials`) holding a small JSON object, and read at most once per launch.
///
/// One item means one Keychain approval instead of one per secret. Because the app creates
/// the item itself, its own code signature is on the item's access list and later reads
/// don't prompt, as long as the signing identity stays the same across builds: `make app`
/// signs with the Makefile's `SIGN_IDENTITY` when that certificate is in your keychain, and
/// ad hoc otherwise (a new signature every build, so the Keychain asks again).
enum Keychain {
    enum Account: String {
        case slackUserToken = "slack-user-token"
        case typesafeAPIKey = "typesafe-api-key"
    }

    static let service = "xyz.merkl.bridgetown"
    private static let credentialsAccount = "credentials"

    @MainActor private static var cache: [String: String]?

    /// The secrets saved, or nil when the Keychain refused to say (access denied, or
    /// locked). A refusal isn't remembered: the next call asks again.
    @MainActor
    static func secrets() -> [Account: String]? {
        guard let stored = credentials() else { return nil }
        return stored.reduce(into: [:]) { out, entry in
            if let account = Account(rawValue: entry.key), !entry.value.isEmpty { out[account] = entry.value }
        }
    }

    /// Saves every secret at once, in one write; an empty value removes that one. Refuses
    /// while the saved ones can't be read, rather than write over what it couldn't see.
    @MainActor
    static func save(_ values: [Account: String]) -> Bool {
        guard var next = credentials() else { return false }
        for (account, value) in values {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            next[account.rawValue] = trimmed.isEmpty ? nil : trimmed
        }
        #if DEBUG
        if inMemory != nil {
            inMemory = next
            return true
        }
        #endif
        guard store(next) else { return false }
        cache = next
        return true
    }

    // MARK: Storage

    #if DEBUG
    /// Stands in for the Keychain item while set: an e2e run (`E2EHarness`) never reads or
    /// writes the real tokens, and a rebuilt debug binary, a new signature, would put up a
    /// Keychain prompt that blocks it.
    @MainActor static var inMemory: [String: String]?
    #endif

    /// The saved secrets: empty when there is no item yet, nil when the Keychain refused.
    @MainActor
    private static func credentials() -> [String: String]? {
        #if DEBUG
        if let inMemory { return inMemory }
        #endif
        if let cache { return cache }
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        cache = stored(status, item as? Data)
        return cache
    }

    /// What a read of the item found: its secrets, none when there is no item yet, and nil
    /// for any other status, which must not pass for "nothing saved".
    static func stored(_ status: OSStatus, _ data: Data?) -> [String: String]? {
        switch status {
        case errSecSuccess: data.flatMap { try? JSONDecoder().decode([String: String].self, from: $0) } ?? [:]
        case errSecItemNotFound: [:]
        default: nil
        }
    }

    private static func store(_ values: [String: String]) -> Bool {
        guard let data = try? JSONEncoder().encode(values) else { return false }
        let status = SecItemUpdate(baseQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status != errSecItemNotFound { return status == errSecSuccess }
        var add = baseQuery
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        add[kSecAttrLabel as String] = "Bridgetown credentials"
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: credentialsAccount,
        ]
    }
}
