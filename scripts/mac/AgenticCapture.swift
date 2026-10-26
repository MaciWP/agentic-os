// AgenticCapture: the bundle macOS grants Screen Recording to, never Terminal and the agent
// shells under it. The selection is the system's own (`screencapture -i`: drag a zone, Space
// for a window, Esc to cancel), run as this app's child so the grant that counts is this
// bundle's.
//
//   capture <out.png> <maxBytes>   one selection, written to <out.png>
//   grant                          asks macOS for Screen Recording (the user starts it)
//   hotkey <serverPid> <origin> <dir> <maxBytes>
//                                  stays running: ⌃⌘4 takes a selection into <dir>, hands its
//                                  name to the server and shows the server's answer for 2 s,
//                                  without taking the focus. Ends with the server.
//
// The one-shot operations print one JSON envelope, {"ok":true,"data":…} or
// {"ok":false,"reason":…}, and exit; the server launches them with `open -n -g -W --stdout`,
// see server/features/mac/run.ts. The resident one reports to the server over HTTP
// (server/features/images/hotkey.ts). Keep this file stable: every build is a new identity to
// macOS, which then asks for Screen Recording again.

import AppKit
import Carbon
import Foundation

func emit(_ envelope: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: envelope)) ?? Data(#"{"ok":false,"reason":"encode"}"#.utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}
func fail(_ reason: String, _ detail: String? = nil) -> Never {
  var e: [String: Any] = ["ok": false, "reason": reason]
  if let detail { e["detail"] = detail }
  emit(e)
}

enum Shot {
  case captured
  case cancelled
  case denied
  // Granted to this bundle, yet screencapture was refused: it did not inherit the grant.
  case notInherited(String)
  case failed(String)
}

// The selection running now, stopped when a deadline ends the one-shot capture.
var child: Process?

func shoot(to path: String, max: Int) -> Shot {
  guard CGPreflightScreenCaptureAccess() else { return .denied }
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  p.arguments = ["-i", "-x", "-t", "png", path]
  let err = Pipe()
  p.standardError = err
  p.standardOutput = FileHandle.nullDevice
  do { try p.run() } catch { return .failed("\(error)") }
  child = p
  let said = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  p.waitUntilExit()
  child = nil
  if FileManager.default.fileExists(atPath: path) {
    shrink(path, max)
    return .captured
  }
  // Esc ends the selection with no file and nothing said.
  if said.isEmpty { return .cancelled }
  if said.contains("could not create image") { return .notInherited(said) }
  return .failed(said)
}

// A busy Retina screen can pass the server's cap as PNG; JPEG keeps it readable and small.
func shrink(_ path: String, _ max: Int) {
  let url = URL(fileURLWithPath: path)
  guard let data = try? Data(contentsOf: url), data.count > max,
    let rep = NSBitmapImageRep(data: data),
    let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.9])
  else { return }
  try? jpeg.write(to: url)
}

// The resident: one hotkey, one selection at a time, and a short notice of where it went.
final class Resident {
  let origin: String
  let dir: String
  let max: Int
  var busy = false
  var notice: NSPanel?

  init(origin: String, dir: String, max: Int) {
    self.origin = origin
    self.dir = dir
    self.max = max
  }

  // Origin and Content-Type are what the server's local guard asks of every write.
  func post(_ path: String, _ body: [String: Any], done: @escaping ([String: Any]?) -> Void = { _ in }) {
    guard let url = URL(string: origin + path) else { return done(nil) }
    var req = URLRequest(url: url, timeoutInterval: 20)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue(origin, forHTTPHeaderField: "Origin")
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    URLSession.shared.dataTask(with: req) { data, response, _ in
      let ok = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
      let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      DispatchQueue.main.async { done(ok ? json : nil) }
    }.resume()
  }

  func state(_ state: String, _ detail: String? = nil) {
    var body: [String: Any] = ["state": state, "pid": Int(ProcessInfo.processInfo.processIdentifier)]
    if let detail { body["detail"] = detail }
    post("/api/images/hotkey/state", body)
  }

  func pressed() {
    if busy { return }
    busy = true
    state("capturing")
    let name = UUID().uuidString.lowercased() + ".png"
    let path = (dir as NSString).appendingPathComponent(name)
    DispatchQueue.global(qos: .userInitiated).async {
      let shot = shoot(to: path, max: self.max)
      DispatchQueue.main.async { self.handle(shot, name: name, path: path) }
    }
  }

  private func handle(_ shot: Shot, name: String, path: String) {
    switch shot {
    case .captured:
      // The server reads the file, keeps it and removes it; a refusal leaves no capture behind.
      post("/api/images/hotkey/shot", ["file": name]) { answer in
        if let text = answer?["text"] as? String {
          self.show(text)
        } else {
          try? FileManager.default.removeItem(atPath: path)
          self.show("Agentic OS no ha guardado la captura")
          self.state("ready")
        }
        self.busy = false
      }
      return
    case .cancelled:
      state("ready")
    case .denied:
      show("Falta el permiso de Grabación de pantalla: concédelo desde Agentic OS")
      state("denied")
    case let .notInherited(detail):
      show("macOS no ha dejado capturar la pantalla")
      state("not_inherited", detail)
    case let .failed(detail):
      show("No se ha podido capturar la pantalla")
      state("failed", detail)
    }
    busy = false
  }

  // A notice that never takes the focus, near the bottom of the screen under the pointer.
  func show(_ text: String) {
    notice?.orderOut(nil)
    let label = NSTextField(labelWithString: text)
    label.font = .systemFont(ofSize: 13, weight: .medium)
    label.textColor = .white
    label.lineBreakMode = .byTruncatingTail
    label.sizeToFit()
    let pad: CGFloat = 16
    let width = min(label.frame.width, 560)
    let size = NSSize(width: width + pad * 2, height: label.frame.height + 18)
    let mouse = NSEvent.mouseLocation
    guard let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main
    else { return }
    let area = screen.visibleFrame
    let panel = NSPanel(
      contentRect: NSRect(x: area.midX - size.width / 2, y: area.minY + 80, width: size.width, height: size.height),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.level = .statusBar
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.ignoresMouseEvents = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    let view = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
    view.appearance = NSAppearance(named: .vibrantDark)
    view.material = .hudWindow
    view.state = .active
    view.wantsLayer = true
    view.layer?.cornerRadius = 10
    view.layer?.masksToBounds = true
    label.frame = NSRect(x: pad, y: (size.height - label.frame.height) / 2, width: width, height: label.frame.height)
    view.addSubview(label)
    panel.contentView = view
    panel.orderFrontRegardless()
    notice = panel
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
      guard self.notice === panel else { return }
      NSAnimationContext.runAnimationGroup({ $0.duration = 0.25; panel.animator().alphaValue = 0 }) {
        panel.orderOut(nil)
        if self.notice === panel { self.notice = nil }
      }
    }
  }
}

// The Carbon callback cannot capture its context: it reaches the resident through this.
var resident: Resident?
var hotKey: EventHotKeyRef?
// The server and SIGTERM watches live as long as the app.
var sources: [DispatchSourceProtocol] = []

func hotkey(serverPid: pid_t, origin: String, dir: String, max: Int) {
  let r = Resident(origin: origin, dir: dir, max: max)
  resident = r
  // Ends with the server: a new server starts its own resident.
  guard kill(serverPid, 0) == 0 else { exit(0) }
  let server = DispatchSource.makeProcessSource(identifier: serverPid, eventMask: .exit, queue: .main)
  server.setEventHandler { exit(0) }
  server.resume()
  signal(SIGTERM, SIG_IGN)
  let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
  term.setEventHandler { exit(0) }
  term.resume()
  var pressed = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
  InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
    resident?.pressed()
    return noErr
  }, 1, &pressed, nil, nil)
  // ⌃⌘4: the agent's ⌘⇧4. A registration taken by another app is said, not retried.
  let id = EventHotKeyID(signature: OSType(0x414F_5343), id: 1)
  let status = RegisterEventHotKey(UInt32(kVK_ANSI_4), UInt32(controlKey | cmdKey), id, GetApplicationEventTarget(), 0, &hotKey)
  if status != noErr {
    r.post("/api/images/hotkey/state", [
      "state": status == OSStatus(eventHotKeyExistsErr) ? "taken" : "failed",
      "pid": Int(ProcessInfo.processInfo.processIdentifier),
      "detail": "RegisterEventHotKey \(status)",
    ]) { _ in exit(0) }
  } else {
    r.state(CGPreflightScreenCaptureAccess() ? "ready" : "denied")
  }
  sources = [server, term]
}

let args = Array(CommandLine.arguments.dropFirst())

switch args.first {
case "capture":
  guard args.count == 3, args[1].hasPrefix("/"), let max = Int(args[2]), max > 0 else { fail("bad_input") }
  // Answers before the server stops waiting (CAPTURE_TIMEOUT_MS), with the selection closed.
  DispatchQueue.main.asyncAfter(deadline: .now() + 95) {
    child?.terminate()
    fail("timeout")
  }
  DispatchQueue.global(qos: .userInitiated).async {
    let shot = shoot(to: args[1], max: max)
    DispatchQueue.main.async {
      switch shot {
      case .captured: emit(["ok": true, "data": ["captured": true]])
      case .cancelled: fail("cancelled")
      case .denied: fail("denied")
      case let .notInherited(detail): fail("not_inherited", detail)
      case let .failed(detail): fail("failed", detail)
      }
    }
  }
case "grant":
  guard args.count == 1 else { fail("bad_input") }
  DispatchQueue.main.asyncAfter(deadline: .now() + 30) { fail("timeout") }
  DispatchQueue.main.async {
    if CGPreflightScreenCaptureAccess() { emit(["ok": true, "data": ["granted": true]]) }
    NSApplication.shared.activate()
    // Shows macOS's own request, which leads to System Settings; the switch is the user's.
    let granted = CGRequestScreenCaptureAccess()
    emit(["ok": true, "data": ["granted": granted]])
  }
case "hotkey":
  guard args.count == 5, let pid = Int32(args[1]), pid > 1, args[2].hasPrefix("http://127.0.0.1:"),
    args[3].hasPrefix("/"), let max = Int(args[4]), max > 0
  else { fail("bad_input") }
  DispatchQueue.main.async { hotkey(serverPid: pid, origin: args[2], dir: args[3], max: max) }
default:
  fail("bad_input")
}
// An accessory app (no Dock icon): macOS shows its consent dialogs, a bare process may get none.
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
