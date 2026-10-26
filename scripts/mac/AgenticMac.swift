// AgenticMac: the bridge to the Outlook account the Mac already syncs (Exchange in Internet
// Accounts). Calendar through EventKit, Mail through Mail.app's scripting, both inside this
// process so macOS grants Calendars and Automation to this bundle, never to Terminal and the
// agent shells under it. Fixed operations only: it never runs a script it is given, and data
// reaches the scripts as Apple Event parameters, never spliced into their source.
//
//   events <fromISO> <toISO>   the Exchange events in [from, to)
//   inbox                      the Exchange inbox: newest 200 messages and the total
//   stamp                      a hash of the inbox's ids, read and flag marks: what `inbox`
//                              prints changes only when it does, at a fraction of its cost
//   message <id>               one inbox message as plain text
//   folders                    every folder of the account, its size and its frequent senders
//   apply <file.json>          moves inbox messages to folders or to the account's trash, after
//                              the user confirms the batch in a native dialog
//   confirm <file.json>        the same dialog for a Gmail batch, which the server then applies;
//                              it touches no mail
//   grant                      asks for Calendars and Mail automation (the user starts it)
//
// It never sends mail and never deletes for good: "trash" moves to the account's Deleted Items.
// It prints one JSON envelope, {"ok":true,"data":…} or {"ok":false,"reason":…}, and exits. The
// server launches it with `open -n -g -W --stdout`, see server/features/mac/run.ts.

import AppKit
import Carbon
import CryptoKit
import EventKit
import Foundation

let MAX_BODY = 64 * 1024
// ponytail: newest 200 of the inbox, page when an inbox over 200 needs the rest.
let INBOX_MAX = 200
// Senders read per folder to learn where mail goes: the newest, the way the user files today.
let FOLDER_SAMPLE = 100
let APPLY_MAX = 500
let TEAMS = try! NSRegularExpression(pattern: #"https://teams\.microsoft\.com/l/meetup-join/[^\s"<>]+"#)

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

let iso = ISO8601DateFormatter()
let day: DateFormatter = {
  let f = DateFormatter()
  f.calendar = Calendar(identifier: .gregorian)
  f.locale = Locale(identifier: "en_US_POSIX")
  f.dateFormat = "yyyy-MM-dd"
  return f
}()

// The first Teams join link in the event's text. The notes themselves never leave the process.
func teamsLink(_ texts: [String?]) -> String? {
  for case let t? in texts {
    let range = NSRange(t.startIndex..., in: t)
    if let m = TEAMS.firstMatch(in: t, range: range), let r = Range(m.range, in: t) { return String(t[r]) }
  }
  return nil
}

func events(from: Date, to: Date) {
  let store = EKEventStore()
  let read = {
    let calendars = store.calendars(for: .event).filter { $0.source.sourceType == .exchange }
    if calendars.isEmpty { fail("no_exchange") }
    let found = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: calendars))
    let out: [[String: Any]] = found
      .filter { $0.status != .canceled }
      .sorted { $0.startDate < $1.startDate }
      .map { e in
        // All-day events as dates, end exclusive, the way Google returns them.
        let end = e.isAllDay ? Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: e.endDate))! : e.endDate!
        return [
          "id": e.calendarItemExternalIdentifier ?? e.calendarItemIdentifier,
          "occurrence": iso.string(from: e.occurrenceDate ?? e.startDate),
          "title": e.title ?? NSNull(),
          "start": e.isAllDay ? day.string(from: e.startDate) : iso.string(from: e.startDate),
          "end": e.isAllDay ? day.string(from: end) : iso.string(from: end),
          "allDay": e.isAllDay,
          "location": e.location ?? NSNull(),
          "meet": teamsLink([e.url?.absoluteString, e.location, e.notes]) ?? NSNull(),
          "calendar": e.calendar.title,
          "attendees": (e.attendees ?? []).compactMap { $0.name },
        ]
      }
    emit(["ok": true, "data": ["events": out]])
  }
  // A read never asks: consent is the `grant` operation, which the user starts on purpose.
  switch EKEventStore.authorizationStatus(for: .event) {
  case .fullAccess: read()
  case .notDetermined: fail("not_granted")
  default: fail("denied")
  }
}

// Asks macOS for both permissions, in the foreground, with time for the user to answer.
func grant() {
  NSApplication.shared.activate()
  EKEventStore().requestFullAccessToEvents { granted, _ in
    DispatchQueue.main.async {
      var mail = "mail_closed"
      if !NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.mail").isEmpty {
        let target = NSAppleEventDescriptor(bundleIdentifier: "com.apple.mail")
        let status = AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, true)
        mail = status == noErr ? "granted" : status == OSStatus(errAEEventNotPermitted) ? "denied" : "error \(status)"
      }
      emit(["ok": true, "data": ["calendar": granted ? "granted" : "denied", "mail": mail]])
    }
  }
}

// Mail is read only while it runs: launching it is the user's call, not a background fetch's.
func requireMail() {
  if NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.mail").isEmpty { fail("mail_closed") }
}

// The handlers every Mail operation calls. Mail has no `ews` account type and localizes the
// mailbox names, so the Exchange account is "not pop, imap, iCloud or smtp" and its inbox and
// trash are picked from the top-level `inbox` and `trash mailbox` by account name.
let MAIL_SCRIPT = """
on exchangeaccount()
  tell application "Mail"
    repeat with a in accounts
      if account type of a is not in {pop, imap, iCloud, smtp} then return contents of a
    end repeat
  end tell
  error "no_exchange" number 1001
end exchangeaccount

on accountbox(acc, role)
  tell application "Mail"
    if role is "inbox" then
      set tops to mailboxes of inbox
    else if role is "trash" then
      set tops to mailboxes of trash mailbox
    else if role is "junk" then
      set tops to mailboxes of junk mailbox
    else if role is "sent" then
      set tops to mailboxes of sent mailbox
    else
      set tops to mailboxes of drafts mailbox
    end if
    repeat with mb in tops
      if name of account of mb is name of acc then return contents of mb
    end repeat
  end tell
  if role is "inbox" then error "no_inbox" number 1002
  return missing value
end accountbox

on inboxrows()
  set box to accountbox(exchangeaccount(), "inbox")
  tell application "Mail"
    return {id of every message of box, message id of every message of box, subject of every message of box, sender of every message of box, date received of every message of box, read status of every message of box, flagged status of every message of box}
  end tell
end inboxrows

on inboxstamp()
  set box to accountbox(exchangeaccount(), "inbox")
  tell application "Mail"
    return {id of every message of box, read status of every message of box, flagged status of every message of box}
  end tell
end inboxstamp

on readmessage(mid)
  set box to accountbox(exchangeaccount(), "inbox")
  tell application "Mail"
    set m to first message of box whose id is mid
    set tos to {}
    repeat with r in to recipients of m
      set end of tos to address of r
    end repeat
    set ccs to {}
    repeat with r in cc recipients of m
      set end of ccs to address of r
    end repeat
    return {message id of m, subject of m, sender of m, date received of m, content of m, tos, ccs}
  end tell
end readmessage

-- `mailboxes of acc` is already flat, nested folders included, each named by its leaf alone:
-- the path comes from walking `container` up to the account, whose name it leaves out.
on pathof(mb)
  tell application "Mail"
    set p to name of mb
    set c to mb
    repeat 20 times
      try
        set c to container of c
        if c is missing value then exit repeat
        set p to (name of c) & "/" & p
      on error
        exit repeat
      end try
    end repeat
  end tell
  return p
end pathof

on folderpaths(acc)
  set out to {}
  tell application "Mail"
    set boxes to mailboxes of acc
    set lead to (name of acc) & "/"
  end tell
  repeat with mb in boxes
    set p to pathof(contents of mb)
    if p starts with lead then set p to text ((length of lead) + 1) thru -1 of p
    set end of out to {p, contents of mb}
  end repeat
  return out
end folderpaths

-- Every folder of the account as {path, role, total, senders of the newest few}.
on folderrows(sample)
  set acc to exchangeaccount()
  set specials to {}
  repeat with r in {"inbox", "trash", "junk", "sent", "drafts"}
    set end of specials to {contents of r, accountbox(acc, contents of r)}
  end repeat
  set out to {}
  repeat with f in folderpaths(acc)
    set mb to item 2 of f
    set role to ""
    repeat with s in specials
      if (item 2 of s) is not missing value and mb is (item 2 of s) then set role to item 1 of s
    end repeat
    tell application "Mail"
      set n to count of messages of mb
      set senders to {}
      if n > sample then
        set senders to sender of messages 1 thru sample of mb
      else if n > 0 then
        set senders to sender of every message of mb
      end if
    end tell
    set end of out to {item 1 of f, role, n, senders}
  end repeat
  return out
end folderrows

-- One result per item: "ok", "not_found" (no longer in the inbox), "no_folder" or "error <n>".
on applybatch(mids, ops, folders)
  set acc to exchangeaccount()
  set box to accountbox(acc, "inbox")
  set binbox to accountbox(acc, "trash")
  set paths to folderpaths(acc)
  set results to {}
  repeat with i from 1 to count of mids
    set mid to item i of mids
    set op to item i of ops
    set target to missing value
    if op is "trash" then
      set target to binbox
    else
      repeat with f in paths
        if item 1 of f is (item i of folders) then set target to item 2 of f
      end repeat
    end if
    if target is missing value then
      set end of results to "no_folder"
    else
      try
        tell application "Mail"
          set m to first message of box whose message id is mid
          move m to target
        end tell
        set end of results to "ok"
      on error msg number n
        if n is -1719 then
          set end of results to "not_found"
        else
          set end of results to "error " & n
        end if
      end try
    end if
  end repeat
  return results
end applybatch
"""

let mailScript: NSAppleScript = {
  var error: NSDictionary?
  guard let s = NSAppleScript(source: MAIL_SCRIPT), s.compileAndReturnError(&error) else {
    fail("script", "compile \(error?[NSAppleScript.errorMessage] as? String ?? "")")
  }
  return s
}()

// Calls one handler of MAIL_SCRIPT with its arguments as event parameters.
func call(_ handler: String, _ args: [NSAppleEventDescriptor] = []) -> NSAppleEventDescriptor {
  let event = NSAppleEventDescriptor(
    eventClass: AEEventClass(kASAppleScriptSuite), eventID: AEEventID(kASSubroutineEvent),
    targetDescriptor: .currentProcess(), returnID: AEReturnID(kAutoGenerateReturnID),
    transactionID: AETransactionID(kAnyTransactionID))
  event.setDescriptor(NSAppleEventDescriptor(string: handler), forKeyword: AEKeyword(keyASSubroutineName))
  let params = NSAppleEventDescriptor.list()
  for a in args { params.insert(a, at: params.numberOfItems + 1) }
  event.setParam(params, forKeyword: AEKeyword(keyDirectObject))
  var error: NSDictionary?
  let result = mailScript.executeAppleEvent(event, error: &error)
  if let error {
    let number = error[NSAppleScript.errorNumber] as? Int ?? 0
    if number == 1001 { fail("no_exchange") }
    // The inbox of the account is not synced yet.
    if number == 1002 { fail("no_inbox") }
    // -1719: no message with that id in the inbox (read elsewhere, moved or deleted).
    if number == -1719 { fail("not_found") }
    // -1743: the user has not allowed this app to control Mail.
    if number == -1743 { fail("denied") }
    // The message can quote mail data: only its start travels.
    fail("script", "\(number) \((error[NSAppleScript.errorMessage] as? String ?? "").prefix(160))")
  }
  return result
}

func strings(_ list: [String]) -> NSAppleEventDescriptor {
  let d = NSAppleEventDescriptor.list()
  for s in list { d.insert(NSAppleEventDescriptor(string: s), at: d.numberOfItems + 1) }
  return d
}

func list(_ d: NSAppleEventDescriptor) -> [NSAppleEventDescriptor] {
  d.numberOfItems == 0 ? [] : (1...d.numberOfItems).compactMap { d.atIndex($0) }
}

func text(_ d: NSAppleEventDescriptor) -> Any {
  guard d.descriptorType != typeType, let s = d.stringValue else { return NSNull() }
  return s
}

func inbox() {
  requireMail()
  // One Apple Event per property: a loop over messages took 5 s for 50.
  let cols = list(call("inboxrows")).map(list)
  let total = cols[0].count
  let rows: [[String: Any]] = (0..<total).map { i in
    [
      "id": String(cols[0][i].int32Value),
      "messageId": cols[1][i].stringValue ?? "",
      "subject": text(cols[2][i]),
      "from": cols[3][i].stringValue ?? "",
      "at": iso.string(from: cols[4][i].dateValue ?? .distantPast),
      "unread": !cols[5][i].booleanValue,
      "flagged": cols[6][i].booleanValue,
    ]
  }
  let newest = rows.sorted { ($0["at"] as! String) > ($1["at"] as! String) }.prefix(INBOX_MAX)
  emit(["ok": true, "data": ["total": total, "messages": Array(newest)]])
}

// Numbers and booleans only: three Apple Events, no subject, sender or date to convert.
func stamp() {
  requireMail()
  let cols = list(call("inboxstamp")).map(list)
  let total = cols[0].count
  let marks = (0..<total).map { i in
    "\(cols[0][i].int32Value):\(cols[1][i].booleanValue ? 1 : 0)\(cols[2][i].booleanValue ? 1 : 0)"
  }
  let hash = SHA256.hash(data: Data(marks.joined(separator: ",").utf8))
  emit(["ok": true, "data": ["total": total, "hash": hash.map { String(format: "%02x", $0) }.joined()]])
}

func message(_ id: Int) {
  requireMail()
  let f = list(call("readmessage", [NSAppleEventDescriptor(int32: Int32(id))]))
  let body = f[4].stringValue ?? ""
  let join = { (d: NSAppleEventDescriptor) -> Any in
    let a = list(d).compactMap { $0.stringValue }
    return a.isEmpty ? NSNull() : a.joined(separator: ", ")
  }
  emit([
    "ok": true,
    "data": [
      "id": String(id),
      "messageId": f[0].stringValue ?? "",
      "subject": text(f[1]),
      "from": f[2].stringValue ?? "",
      "at": iso.string(from: f[3].dateValue ?? .distantPast),
      "body": String(body.prefix(MAX_BODY)),
      "truncated": body.count > MAX_BODY,
      "to": join(f[5]),
      "cc": join(f[6]),
    ],
  ])
}

func folders() {
  requireMail()
  let rows: [[String: Any]] = list(call("folderrows", [NSAppleEventDescriptor(int32: Int32(FOLDER_SAMPLE))])).map { row in
    let f = list(row)
    var senders: [String: Int] = [:]
    for s in list(f[3]) { if let v = s.stringValue { senders[v, default: 0] += 1 } }
    return [
      "path": f[0].stringValue ?? "",
      "role": f[1].stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? NSNull(),
      "total": Int(f[2].int32Value),
      "senders": senders.sorted { $0.value > $1.value }.map { ["from": $0.key, "count": $0.value] },
    ]
  }
  emit(["ok": true, "data": ["folders": rows]])
}

struct Item {
  let messageId: String
  let op: String
  let folder: String
}

// The batch arrives as a file of data. Nothing in it runs: the handler matches folder paths
// against the account's own folders and messages by id.
func readBatch(_ path: String) -> [Item] {
  guard let data = FileManager.default.contents(atPath: path), data.count <= 1 << 20,
    let raw = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
    !raw.isEmpty, raw.count <= APPLY_MAX
  else { fail("bad_input") }
  return raw.map { r in
    guard let mid = r["messageId"] as? String, !mid.isEmpty, mid.count <= 998,
      let op = r["op"] as? String, op == "move" || op == "trash"
    else { fail("bad_input") }
    let folder = r["folder"] as? String ?? ""
    if op == "move" && folder.isEmpty { fail("bad_input") }
    return Item(messageId: mid, op: op, folder: folder)
  }
}

// The user's click is the gate: an agent can start this app, but cannot press the button.
func confirm(_ items: [Item], _ app: String) -> Bool {
  var lines: [String] = []
  let moves = Dictionary(grouping: items.filter { $0.op == "move" }, by: \.folder)
  for (folder, group) in moves.sorted(by: { $0.key < $1.key }) { lines.append("→ \(folder): \(group.count)") }
  let trash = items.filter { $0.op == "trash" }.count
  if trash > 0 { lines.append("→ \(app == "Gmail" ? "Papelera" : "Elementos eliminados"): \(trash)") }
  NSApplication.shared.activate()
  let alert = NSAlert()
  alert.messageText = "Agentic OS quiere ordenar \(items.count) correos de \(app)"
  alert.informativeText = lines.joined(separator: "\n") + "\n\nNada se borra para siempre ni se envía."
  alert.addButton(withTitle: "Aplicar")
  alert.addButton(withTitle: "Cancelar")
  alert.window.level = .floating
  return alert.runModal() == .alertFirstButtonReturn
}

func apply(_ path: String) {
  requireMail()
  let items = readBatch(path)
  guard confirm(items, "Outlook") else { fail("cancelled") }
  let results = list(call("applybatch", [
    strings(items.map(\.messageId)), strings(items.map(\.op)), strings(items.map(\.folder)),
  ]))
  let out: [[String: Any]] = zip(items, results).map { item, r in
    ["messageId": item.messageId, "result": r.stringValue ?? "error"]
  }
  emit(["ok": true, "data": ["results": out]])
}

// Gmail's batch: the user's click, nothing else. The server applies it through Gmail's API.
func confirmOnly(_ path: String) {
  let items = readBatch(path)
  guard confirm(items, "Gmail") else { fail("cancelled") }
  emit(["ok": true, "data": ["confirmed": true]])
}

let args = Array(CommandLine.arguments.dropFirst())

// A busy Mail or an unanswered dialog never keeps the process around.
let deadline: Double = switch args.first {
case "grant", "apply", "confirm": 120
case "folders": 60
default: 15
}
DispatchQueue.main.asyncAfter(deadline: .now() + deadline) { fail("timeout") }

switch args.first {
case "grant":
  guard args.count == 1 else { fail("bad_input") }
  DispatchQueue.main.async { grant() }
case "events":
  guard args.count == 3, let from = iso.date(from: args[1]), let to = iso.date(from: args[2]), from < to else { fail("bad_input") }
  DispatchQueue.main.async { events(from: from, to: to) }
case "inbox":
  guard args.count == 1 else { fail("bad_input") }
  DispatchQueue.main.async { inbox() }
case "stamp":
  guard args.count == 1 else { fail("bad_input") }
  DispatchQueue.main.async { stamp() }
case "message":
  guard args.count == 2, let id = Int(args[1]), id > 0, id <= Int(Int32.max) else { fail("bad_input") }
  DispatchQueue.main.async { message(id) }
case "folders":
  guard args.count == 1 else { fail("bad_input") }
  DispatchQueue.main.async { folders() }
case "apply":
  guard args.count == 2, args[1].hasPrefix("/") else { fail("bad_input") }
  DispatchQueue.main.async { apply(args[1]) }
case "confirm":
  guard args.count == 2, args[1].hasPrefix("/") else { fail("bad_input") }
  DispatchQueue.main.async { confirmOnly(args[1]) }
default:
  fail("bad_input")
}
// An accessory app (no Dock icon): macOS shows its consent dialogs, a bare process may get none.
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
