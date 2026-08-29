import Foundation
import Security

enum KeychainStore {
    private static let service = "com.edmen12.deskmcp.tunnel-runtime"
    private static let account = "runtime-api-key"

    static func read() throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError.from(status) }
        guard let data = item as? Data,
              let value = String(data: data, encoding: .utf8),
              !value.isEmpty else {
            throw KeychainError.invalidData
        }
        return value
    }

    static func save(_ value: String) throws {
        guard !value.isEmpty else { throw KeychainError.invalidData }
        let data = Data(value.utf8)
        let lookup: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let status = SecItemCopyMatching(lookup as CFDictionary, nil)
        if status == errSecSuccess {
            let update = [kSecValueData as String: data]
            let result = SecItemUpdate(lookup as CFDictionary, update as CFDictionary)
            guard result == errSecSuccess else { throw KeychainError.from(result) }
        } else {
            guard status == errSecItemNotFound else { throw KeychainError.from(status) }
            var add = lookup
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let result = SecItemAdd(add as CFDictionary, nil)
            guard result == errSecSuccess else { throw KeychainError.from(result) }
        }

        guard try read() == value else { throw KeychainError.invalidData }
    }

    static func remove() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.from(status)
        }
    }
}

enum KeychainError: LocalizedError, Equatable {
    case interactionNotAllowed
    case accessDenied
    case unavailable
    case invalidData
    case status(OSStatus)

    static func from(_ status: OSStatus) -> KeychainError {
        switch status {
        case errSecInteractionNotAllowed: return .interactionNotAllowed
        case errSecAuthFailed, errSecUserCanceled: return .accessDenied
        case errSecNotAvailable: return .unavailable
        default: return .status(status)
        }
    }

    var errorDescription: String? {
        switch self {
        case .interactionNotAllowed: return "Keychain is locked or interaction is unavailable."
        case .accessDenied: return "Keychain access was denied."
        case .unavailable: return "Keychain is currently unavailable."
        case .invalidData: return "Stored Runtime API Key is unreadable. Re-enter API key."
        case .status(let code): return "Keychain operation failed (\(code))."
        }
    }
}
