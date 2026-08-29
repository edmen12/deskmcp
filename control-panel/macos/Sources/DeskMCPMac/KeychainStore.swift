import Foundation
import Security

enum KeychainStore {
    private static let service = "com.edmen12.deskmcp.tunnel-runtime"
    private static let account = "runtime-api-key"

    static func read() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ value: String) throws {
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
            guard result == errSecSuccess else { throw KeychainError.status(result) }
            return
        }
        guard status == errSecItemNotFound else { throw KeychainError.status(status) }
        var add = lookup
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let result = SecItemAdd(add as CFDictionary, nil)
        guard result == errSecSuccess else { throw KeychainError.status(result) }
    }

    static func remove() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.status(status)
        }
    }
}

enum KeychainError: LocalizedError {
    case status(OSStatus)
    var errorDescription: String? { "Keychain operation failed (\(statusCode))." }
    private var statusCode: OSStatus { if case .status(let code) = self { return code }; return errSecInternalError }
}
