import Foundation
import Security
import AppKit

enum KeychainHelperError: Error {
    case usage
    case invalidInput
    case status(OSStatus)
}

func query(service: String, account: String) -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ]
}

func fail(_ error: Error) -> Never {
    FileHandle.standardError.write(Data("keychain helper failed\n".utf8))
    exit(1)
}

do {
    let arguments = CommandLine.arguments
    guard arguments.count == 4 else { throw KeychainHelperError.usage }
    let operation = arguments[1]
    let service = arguments[2]
    let account = arguments[3]
    guard !service.isEmpty, !account.isEmpty else { throw KeychainHelperError.invalidInput }

    if operation == "put" || operation == "put-pasteboard" {
        var secret: Data
        if operation == "put-pasteboard" {
            guard let value = NSPasteboard.general.string(forType: .string) else {
                throw KeychainHelperError.invalidInput
            }
            secret = Data(value.utf8)
            NSPasteboard.general.clearContents()
        } else {
            secret = FileHandle.standardInput.readDataToEndOfFile()
        }
        while secret.last == 0x0a || secret.last == 0x0d { secret.removeLast() }
        guard !secret.isEmpty, secret.count <= 16_384 else { throw KeychainHelperError.invalidInput }

        let base = query(service: service, account: account)
        SecItemDelete(base as CFDictionary)
        var item = base
        item[kSecValueData as String] = secret
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainHelperError.status(status) }
        FileHandle.standardOutput.write(Data("stored\n".utf8))
    } else if operation == "get" {
        var item = query(service: service, account: account)
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(item as CFDictionary, &result)
        guard status == errSecSuccess, let secret = result as? Data else {
            throw KeychainHelperError.status(status)
        }
        FileHandle.standardOutput.write(secret)
    } else {
        throw KeychainHelperError.usage
    }
} catch {
    fail(error)
}
