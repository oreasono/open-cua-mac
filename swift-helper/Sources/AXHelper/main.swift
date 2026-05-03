// AXHelper — minimal Accessibility helper for open-cua-mac.
//
// Subcommands (single-shot, JSON in / JSON out):
//   tree           Dump AX tree of the focused application as JSON
//   apps           List running applications with bundle id, pid, focused flag
//   focus <pid>    Activate the app with the given PID
//   click <pid> <ax-id>   Press the AX element with the given path id (from `tree`)
//   set <pid> <ax-id> <value>   Set value on element (text fields)
//
// Element ids are stable within one tree dump but not across dumps — callers
// should re-dump after any state-changing action.

import Cocoa
import ApplicationServices

// MARK: - JSON helpers

func emit(_ obj: Any) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
    exit(0)
}

func fail(_ msg: String, code: Int32 = 1) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: ["error": msg], options: [])
    FileHandle.standardError.write(data)
    FileHandle.standardError.write(Data([0x0A]))
    exit(code)
}

// MARK: - AX wrappers

func axCopy(_ element: AXUIElement, _ attr: String) -> AnyObject? {
    var value: AnyObject?
    let err = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
    return err == .success ? value : nil
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    return (axCopy(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func axRole(_ element: AXUIElement) -> String {
    return (axCopy(element, kAXRoleAttribute) as? String) ?? ""
}

func axTitle(_ element: AXUIElement) -> String? { axCopy(element, kAXTitleAttribute) as? String }
func axValue(_ element: AXUIElement) -> String? {
    if let s = axCopy(element, kAXValueAttribute) as? String { return s }
    if let n = axCopy(element, kAXValueAttribute) as? NSNumber { return n.stringValue }
    return nil
}
func axDescription(_ element: AXUIElement) -> String? { axCopy(element, kAXDescriptionAttribute) as? String }
func axHelp(_ element: AXUIElement) -> String? { axCopy(element, kAXHelpAttribute) as? String }
func axEnabled(_ element: AXUIElement) -> Bool { (axCopy(element, kAXEnabledAttribute) as? Bool) ?? true }

func axFrame(_ element: AXUIElement) -> [String: Double]? {
    guard let posVal = axCopy(element, kAXPositionAttribute),
          let sizeVal = axCopy(element, kAXSizeAttribute) else { return nil }
    var pos = CGPoint.zero
    var size = CGSize.zero
    AXValueGetValue(posVal as! AXValue, .cgPoint, &pos)
    AXValueGetValue(sizeVal as! AXValue, .cgSize, &size)
    return ["x": Double(pos.x), "y": Double(pos.y), "w": Double(size.width), "h": Double(size.height)]
}

// MARK: - Tree dump

func dumpTree(_ element: AXUIElement, path: String, depth: Int, maxDepth: Int) -> [String: Any] {
    var node: [String: Any] = [
        "id": path,
        "role": axRole(element),
    ]
    if let t = axTitle(element), !t.isEmpty { node["title"] = t }
    if let v = axValue(element), !v.isEmpty { node["value"] = v }
    if let d = axDescription(element), !d.isEmpty { node["desc"] = d }
    if let h = axHelp(element), !h.isEmpty { node["help"] = h }
    if let f = axFrame(element) { node["frame"] = f }
    if !axEnabled(element) { node["enabled"] = false }
    if depth < maxDepth {
        let kids = axChildren(element)
        if !kids.isEmpty {
            var arr: [[String: Any]] = []
            for (i, c) in kids.enumerated() {
                arr.append(dumpTree(c, path: "\(path)/\(i)", depth: depth + 1, maxDepth: maxDepth))
            }
            node["children"] = arr
        }
    }
    return node
}

func findByPath(_ root: AXUIElement, path: String) -> AXUIElement? {
    let parts = path.split(separator: "/").compactMap { Int($0) }
    var cur: AXUIElement = root
    for p in parts {
        let kids = axChildren(cur)
        guard p >= 0 && p < kids.count else { return nil }
        cur = kids[p]
    }
    return cur
}

func appByPid(_ pid: pid_t) -> AXUIElement {
    return AXUIElementCreateApplication(pid)
}

func focusedAppPid() -> pid_t? {
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
}

// MARK: - Subcommands

let args = CommandLine.arguments
if args.count < 2 { fail("usage: AXHelper <tree|apps|focus|click|set> ...") }

switch args[1] {
case "apps":
    let apps = NSWorkspace.shared.runningApplications.compactMap { app -> [String: Any]? in
        guard app.activationPolicy == .regular, let name = app.localizedName else { return nil }
        return [
            "pid": Int(app.processIdentifier),
            "name": name,
            "bundle": app.bundleIdentifier ?? "",
            "active": app.isActive,
        ]
    }
    emit(apps)

case "tree":
    let pid: pid_t
    let maxDepth: Int
    if args.count >= 3, let p = Int32(args[2]) {
        pid = p
        maxDepth = args.count >= 4 ? Int(args[3]) ?? 12 : 12
    } else {
        guard let p = focusedAppPid() else { fail("no focused app") }
        pid = p
        maxDepth = args.count >= 3 ? Int(args[2]) ?? 12 : 12
    }
    let app = appByPid(pid)
    emit(dumpTree(app, path: "", depth: 0, maxDepth: maxDepth))

case "focus":
    guard args.count >= 3, let pid = Int32(args[2]) else { fail("usage: focus <pid>") }
    if let app = NSRunningApplication(processIdentifier: pid) {
        app.activate(options: [.activateIgnoringOtherApps])
        emit(["ok": true])
    }
    fail("no app with pid \(pid)")

case "click":
    guard args.count >= 4, let pid = Int32(args[2]) else { fail("usage: click <pid> <ax-id>") }
    let app = appByPid(pid)
    guard let target = findByPath(app, path: args[3]) else { fail("element not found") }
    let err = AXUIElementPerformAction(target, kAXPressAction as CFString)
    if err == .success { emit(["ok": true]) }
    fail("AXPress failed: \(err.rawValue)")

case "set":
    guard args.count >= 5, let pid = Int32(args[2]) else { fail("usage: set <pid> <ax-id> <value>") }
    let app = appByPid(pid)
    guard let target = findByPath(app, path: args[3]) else { fail("element not found") }
    let err = AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, args[4] as CFString)
    if err == .success { emit(["ok": true]) }
    fail("AXSetValue failed: \(err.rawValue)")

default:
    fail("unknown subcommand: \(args[1])")
}
