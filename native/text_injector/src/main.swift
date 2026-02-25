import ApplicationServices
import Foundation

enum InjectorError: Error {
    case invalidArguments(String)
    case permissionDenied
    case focusedElementUnavailable(AXError)
    case setSelectedTextFailed(AXError)
    case createEventSourceFailed
    case createEventFailed

    var message: String {
        switch self {
        case let .invalidArguments(detail):
            return "invalid arguments: \(detail)"
        case .permissionDenied:
            return "accessibility permission is required for native text injection"
        case let .focusedElementUnavailable(error):
            return "unable to read focused UI element: \(error.rawValue)"
        case let .setSelectedTextFailed(error):
            return "unable to set selected text on focused element: \(error.rawValue)"
        case .createEventSourceFailed:
            return "unable to create CGEvent source"
        case .createEventFailed:
            return "unable to create keyboard CGEvent"
        }
    }
}

enum Mode: String {
    case insert
    case replace
}

struct Arguments {
    let mode: Mode
    let deleteCount: Int
    let healthcheck: Bool
}

func parseArguments() throws -> Arguments {
    var mode: Mode = .insert
    var deleteCount = 0
    var healthcheck = false

    var index = 1
    while index < CommandLine.arguments.count {
        let token = CommandLine.arguments[index]

        if token == "--healthcheck" {
            healthcheck = true
            index += 1
            continue
        }

        if token == "--mode" {
            guard index + 1 < CommandLine.arguments.count else {
                throw InjectorError.invalidArguments("missing value for --mode")
            }
            guard let parsedMode = Mode(rawValue: CommandLine.arguments[index + 1]) else {
                throw InjectorError.invalidArguments("unsupported --mode value")
            }
            mode = parsedMode
            index += 2
            continue
        }

        if token == "--delete-count" {
            guard index + 1 < CommandLine.arguments.count else {
                throw InjectorError.invalidArguments("missing value for --delete-count")
            }

            guard let parsedCount = Int(CommandLine.arguments[index + 1]), parsedCount >= 0 else {
                throw InjectorError.invalidArguments("--delete-count must be a non-negative integer")
            }

            deleteCount = parsedCount
            index += 2
            continue
        }

        throw InjectorError.invalidArguments("unknown argument '\(token)'")
    }

    return Arguments(mode: mode, deleteCount: deleteCount, healthcheck: healthcheck)
}

func readStdinText() throws -> String {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    if input.isEmpty {
        return ""
    }

    guard let text = String(data: input, encoding: .utf8) else {
        throw InjectorError.invalidArguments("stdin must be UTF-8 text")
    }

    return text
}

func focusedElement() throws -> AXUIElement {
    let system = AXUIElementCreateSystemWide()
    var focused: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused)

    guard error == .success, let element = focused else {
        throw InjectorError.focusedElementUnavailable(error)
    }

    return unsafeBitCast(element, to: AXUIElement.self)
}

func insertText(_ text: String) throws {
    let element = try focusedElement()
    let error = AXUIElementSetAttributeValue(
        element,
        kAXSelectedTextAttribute as CFString,
        text as CFTypeRef
    )

    guard error == .success else {
        throw InjectorError.setSelectedTextFailed(error)
    }
}

func sendDeleteBackspaces(count: Int) throws {
    if count <= 0 {
        return
    }

    guard let source = CGEventSource(stateID: .combinedSessionState) else {
        throw InjectorError.createEventSourceFailed
    }

    for _ in 0..<count {
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 51, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 51, keyDown: false) else {
            throw InjectorError.createEventFailed
        }

        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}

func run() throws {
    let args = try parseArguments()

    if args.healthcheck {
        print("ok")
        return
    }

    if !AXIsProcessTrusted() {
        throw InjectorError.permissionDenied
    }

    let text = try readStdinText()

    switch args.mode {
    case .insert:
        try insertText(text)
    case .replace:
        try sendDeleteBackspaces(count: args.deleteCount)
        try insertText(text)
    }
}

do {
    try run()
} catch let error as InjectorError {
    fputs(error.message + "\n", stderr)
    exit(1)
} catch {
    fputs(String(describing: error) + "\n", stderr)
    exit(1)
}
