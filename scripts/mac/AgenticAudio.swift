// AgenticAudio: records a call as two 16 kHz mono tracks, in this process so macOS grants
// "System Audio Recording" and Microphone to this bundle, never to Terminal and the agent
// shells under it. It never changes a device's sample rate or format, never turns on voice
// processing (it ducks the other side of the call) and never mutes what it taps.
//
//   probe                                   the Core Audio process objects, as JSON
//   record --dir <abs> --bundle <prefix> [--chunk-seconds 300]
//                                           records until <dir>/stop appears or SIGTERM
//
// Output, which server/features/transcripts depends on: <dir>/mic/000.wav… and
// <dir>/system/000.wav… (16 kHz, mono, PCM 16-bit; a chunk is NNN.wav.part until it is closed)
// and <dir>/state.json, written atomically. The system track is a process tap on every process
// whose bundle id starts with the prefix. The server launches it with `open -n -g -W --stdout`,
// so state.json, not the exit status, is the result of a recording.

import AVFoundation
import CoreAudio
import Foundation
import IOKit.pwr_mgt

let RATE = 16_000.0
// Seconds of exact zeros before the watchdog acts.
let SYSTEM_SILENCE_S = 60.0
let MIC_SILENCE_S = 30.0
let RESCAN_S = 10

func emit(_ envelope: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: envelope)) ?? Data(#"{"ok":false,"reason":"encode"}"#.utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}

// MARK: Core Audio properties

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func read<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
  var addr = address(selector)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  let status = withUnsafeMutableBytes(of: &value) { AudioObjectGetPropertyData(object, &addr, 0, nil, &size, $0.baseAddress!) }
  return status == noErr ? value : nil
}

struct AudioProcess {
  let object: AudioObjectID
  let pid: Int32
  let bundleId: String
  let isRunningOutput: Bool
  let isRunningInput: Bool
}

func processes() -> [AudioProcess] {
  let system = AudioObjectID(kAudioObjectSystemObject)
  var addr = address(kAudioHardwarePropertyProcessObjectList)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
  return ids.compactMap { id in
    guard let pid = read(id, kAudioProcessPropertyPID, Int32(0)) else { return nil }
    let bundle = read(id, kAudioProcessPropertyBundleID, "" as CFString) as String? ?? ""
    return AudioProcess(
      object: id, pid: pid, bundleId: bundle,
      isRunningOutput: (read(id, kAudioProcessPropertyIsRunningOutput, UInt32(0)) ?? 0) != 0,
      isRunningInput: (read(id, kAudioProcessPropertyIsRunningInput, UInt32(0)) ?? 0) != 0)
  }
}

func defaultOutputUID() throws -> String {
  guard let device = read(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, AudioObjectID(0)),
    let uid = read(device, kAudioDevicePropertyDeviceUID, "" as CFString) as String?
  else { throw RecordError("no default output device") }
  return uid
}

struct RecordError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

// Nanoseconds since boot. It stops while the Mac sleeps, so a sleep is not filled with silence.
func uptime() -> UInt64 { DispatchTime.now().uptimeNanoseconds }

// MARK: Tracks

// One track: converts what it is fed to 16 kHz mono Int16 and writes it in chunks. The server
// times a chunk by the samples before it, so the samples a track misses (no tap yet, a rebuild,
// a device change) are written as zeros: both tracks keep the timeline that starts at `origin`.
final class Track {
  let name: String
  private let dir: URL
  private let chunkSamples: Int
  private let queue: DispatchQueue
  private let origin: UInt64
  private let clock: () -> UInt64
  private var converter: AVAudioConverter?
  private var inputFormat: AVAudioFormat?
  private var file: FileHandle?
  private var written = 0
  private var total = 0
  private var started = 0
  private var closed = false
  private var lastNonZero = Date()
  private var failure: String?
  private let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: RATE, channels: 1, interleaved: true)!

  init(name: String, root: URL, chunkSeconds: Int, origin: UInt64, clock: @escaping () -> UInt64 = uptime) {
    self.name = name
    dir = root.appendingPathComponent(name)
    chunkSamples = chunkSeconds * Int(RATE)
    queue = DispatchQueue(label: "agentic-audio.\(name)")
    self.origin = origin
    self.clock = clock
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  }

  // Called from a real-time callback: copies the samples and returns.
  func feed(_ source: AVAudioPCMBuffer) {
    let at = clock()
    guard let copy = AVAudioPCMBuffer(pcmFormat: source.format, frameCapacity: source.frameLength) else { return }
    copy.frameLength = source.frameLength
    let from = UnsafeMutableAudioBufferListPointer(source.mutableAudioBufferList)
    let to = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
    for i in 0..<from.count {
      guard let src = from[i].mData, let dst = to[i].mData else { continue }
      memcpy(dst, src, Int(min(from[i].mDataByteSize, to[i].mDataByteSize)))
    }
    queue.async { self.consume(copy, at: at) }
  }

  private func consume(_ buffer: AVAudioPCMBuffer, at: UInt64) {
    guard failure == nil, !closed, buffer.frameLength > 0 else { return }
    if let data = buffer.floatChannelData {
      let n = Int(buffer.frameLength)
      for c in 0..<Int(buffer.format.channelCount) where (0..<n).contains(where: { data[c][$0] != 0 }) {
        lastNonZero = Date()
        break
      }
    } else {
      lastNonZero = Date()
    }
    if inputFormat != buffer.format {
      inputFormat = buffer.format
      converter = AVAudioConverter(from: buffer.format, to: output)
    }
    guard let converter else {
      failure = "no converter for \(buffer.format)"
      return
    }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * RATE / buffer.format.sampleRate) + 64
    guard let out = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return }
    var supplied = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if supplied {
        status.pointee = .noDataNow
        return nil
      }
      supplied = true
      status.pointee = .haveData
      return buffer
    }
    if let error {
      failure = "convert \(name): \(error.localizedDescription)"
      return
    }
    guard let samples = out.int16ChannelData?[0], out.frameLength > 0 else { return }
    // A buffer arrives as it ends. Behind by more than half a second: the gap becomes zeros. A
    // track ahead (clock drift) keeps its samples.
    let elapsed = at > origin ? Double(at - origin) / 1e9 : 0
    let start = Int(elapsed * RATE) - Int(out.frameLength)
    if start - total > Int(RATE / 2) { append(nil, count: start - total) }
    append(samples, count: Int(out.frameLength))
  }

  // Writes `count` samples, or zeros when `samples` is nil, splitting them across chunks.
  private func append(_ samples: UnsafePointer<Int16>?, count: Int) {
    var offset = 0
    while offset < count {
      if file == nil, !openChunk() { return }
      let n = min(count - offset, chunkSamples - written)
      let data = samples.map { Data(bytes: $0 + offset, count: n * 2) } ?? Data(count: n * 2)
      do {
        try file?.write(contentsOf: data)
      } catch {
        failure = "write \(name): \(error.localizedDescription)"
        return
      }
      written += n
      total += n
      offset += n
      if written >= chunkSamples { closeChunk() }
    }
  }

  private func path(_ suffix: String) -> URL {
    dir.appendingPathComponent(String(format: "%03d.wav", started - 1) + suffix)
  }

  private func openChunk() -> Bool {
    started += 1
    let url = path(".part")
    guard FileManager.default.createFile(atPath: url.path, contents: wavHeader(samples: 0)),
      let handle = try? FileHandle(forWritingTo: url)
    else {
      failure = "cannot create \(url.path)"
      return false
    }
    _ = try? handle.seekToEnd()
    file = handle
    written = 0
    return true
  }

  private func closeChunk() {
    guard let handle = file else { return }
    file = nil
    do {
      try handle.seek(toOffset: 0)
      try handle.write(contentsOf: wavHeader(samples: written))
      try handle.close()
      try FileManager.default.moveItem(at: path(".part"), to: path(""))
    } catch {
      failure = "close \(name): \(error.localizedDescription)"
    }
  }

  // Buffers still in flight after this are dropped, so no chunk is opened that nobody closes.
  func close() {
    queue.sync {
      closeChunk()
      closed = true
    }
  }
  var chunks: Int { queue.sync { started } }
  var error: String? { queue.sync { failure } }
  var silentFor: TimeInterval { queue.sync { Date().timeIntervalSince(lastNonZero) } }
  func resetSilence() { queue.sync { lastNonZero = Date() } }
}

func wavHeader(samples: Int) -> Data {
  var d = Data()
  func u32(_ v: Int) { withUnsafeBytes(of: UInt32(v).littleEndian) { d.append(contentsOf: $0) } }
  func u16(_ v: Int) { withUnsafeBytes(of: UInt16(v).littleEndian) { d.append(contentsOf: $0) } }
  d.append(contentsOf: Array("RIFF".utf8)); u32(36 + samples * 2)
  d.append(contentsOf: Array("WAVEfmt ".utf8)); u32(16)
  u16(1); u16(1); u32(Int(RATE)); u32(Int(RATE) * 2); u16(2); u16(16)
  d.append(contentsOf: Array("data".utf8)); u32(samples * 2)
  return d
}

// MARK: System tap

// A process tap on the given process objects, wrapped in a private aggregate device.
final class SystemTap {
  private var tap = AudioObjectID(kAudioObjectUnknown)
  private var aggregate = AudioObjectID(kAudioObjectUnknown)
  private var proc: AudioDeviceIOProcID?
  private let queue = DispatchQueue(label: "agentic-audio.tap", qos: .userInitiated)

  init(objects: [AudioObjectID], track: Track) throws {
    let description = CATapDescription(monoMixdownOfProcesses: objects)
    description.uuid = UUID()
    description.muteBehavior = .unmuted
    description.isPrivate = true
    var status = AudioHardwareCreateProcessTap(description, &tap)
    guard status == noErr else { throw RecordError("create tap failed: \(status)") }
    do {
      guard var asbd = read(tap, kAudioTapPropertyFormat, AudioStreamBasicDescription()), let format = AVAudioFormat(streamDescription: &asbd)
      else { throw RecordError("tap format unreadable") }
      let outputUID = try defaultOutputUID()
      let config: [String: Any] = [
        kAudioAggregateDeviceNameKey: "AgenticAudio",
        kAudioAggregateDeviceUIDKey: UUID().uuidString,
        kAudioAggregateDeviceMainSubDeviceKey: outputUID,
        kAudioAggregateDeviceIsPrivateKey: true,
        kAudioAggregateDeviceIsStackedKey: false,
        kAudioAggregateDeviceTapAutoStartKey: true,
        kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
        kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
      ]
      status = AudioHardwareCreateAggregateDevice(config as CFDictionary, &aggregate)
      guard status == noErr else { throw RecordError("create aggregate failed: \(status)") }
      status = AudioDeviceCreateIOProcIDWithBlock(&proc, aggregate, queue) { _, input, _, _, _ in
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input, deallocator: nil) else { return }
        track.feed(buffer)
      }
      guard status == noErr else { throw RecordError("create IOProc failed: \(status)") }
      status = AudioDeviceStart(aggregate, proc)
      guard status == noErr else { throw RecordError("start device failed: \(status)") }
    } catch {
      stop()
      throw error
    }
  }

  func stop() {
    if aggregate != kAudioObjectUnknown {
      AudioDeviceStop(aggregate, proc)
      if let proc { AudioDeviceDestroyIOProcID(aggregate, proc) }
      AudioHardwareDestroyAggregateDevice(aggregate)
    }
    if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap) }
    proc = nil
    aggregate = AudioObjectID(kAudioObjectUnknown)
    tap = AudioObjectID(kAudioObjectUnknown)
  }
}

// MARK: Recorder

final class Recorder {
  private let dir: URL
  private let prefix: String
  private let mic: Track
  private let system: Track
  private var engine = AVAudioEngine()
  private var micAllowed = false
  private let startedAt = Date()
  private var tap: SystemTap?
  private var tapped: [AudioProcess] = []
  private var warnings: [String] = []
  private var micWarned = false
  private var assertion = IOPMAssertionID(0)
  private var ticks = 0
  private var lastState = Data()

  init(dir: URL, prefix: String, chunkSeconds: Int) {
    self.dir = dir
    self.prefix = prefix
    let origin = uptime()
    mic = Track(name: "mic", root: dir, chunkSeconds: chunkSeconds, origin: origin)
    system = Track(name: "system", root: dir, chunkSeconds: chunkSeconds, origin: origin)
  }

  // The server fails a helper that has not written its state 30 s after the start, and the
  // first recording waits on the permission prompts: the state goes out before them.
  func announce() { writeState("recording") }

  func run(micAllowed: Bool) {
    self.micAllowed = micAllowed
    IOPMAssertionCreateWithName(
      kIOPMAssertionTypePreventUserIdleSystemSleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn),
      "Agentic OS is recording a call" as CFString, &assertion)
    if micAllowed {
      // Registered once; a restart builds a new engine, which opens the new default input.
      NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { note in
        if note.object as AnyObject? === self.engine { self.restartMic() }
      }
      startMic()
    } else {
      warn("mic_denied")
    }
    // The aggregate is clocked by the default output: a new one (AirPods on or off) rebuilds it.
    var output = address(kAudioHardwarePropertyDefaultSystemOutputDevice)
    AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &output, .main) { _, _ in
      self.rebuild(self.tapped)
    }
    scan()
    writeState("recording")
    signal(SIGTERM, SIG_IGN)
    let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    term.setEventHandler { self.finish() }
    term.resume()
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + 1, repeating: 1)
    timer.setEventHandler { self.tick() }
    timer.resume()
    withExtendedLifetime((term, timer)) { dispatchMain() }
  }

  private func warn(_ text: String) {
    if !warnings.contains(text) { warnings.append(text) }
  }

  private func restartMic() {
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    engine = AVAudioEngine()
    startMic()
  }

  private func startMic() {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      warn("mic_unavailable")
      return
    }
    do {
      // The `error:` variant is the macOS 27 form; the old one is deprecated there. Its Swift
      // refinement is not in the SDK yet, so the import takes a Void placeholder for the error.
      try input.__installTap(onBus: 0, bufferSize: 4096, format: format, error: (), block: { buffer, _ in self.mic.feed(buffer) })
      try engine.start()
    } catch {
      warn("mic_start_failed: \(error.localizedDescription)")
    }
  }

  // The tap's process list is fixed when it is made, so a different set of processes rebuilds it.
  private func scan() {
    let matching = processes().filter { !$0.bundleId.isEmpty && $0.bundleId.hasPrefix(prefix) }
    if Set(matching.map(\.object)) != Set(tapped.map(\.object)) { rebuild(matching) }
  }

  private func rebuild(_ matching: [AudioProcess]) {
    tap?.stop()
    tap = nil
    tapped = []
    system.resetSilence()
    guard !matching.isEmpty else { return }
    do {
      tap = try SystemTap(objects: matching.map(\.object), track: system)
      tapped = matching
    } catch {
      warn("tap_failed: \(error)")
    }
  }

  private func tick() {
    ticks += 1
    if FileManager.default.fileExists(atPath: dir.appendingPathComponent("stop").path) { finish() }
    // The meeting's other side is the system track: a mic failure only warns.
    if let error = system.error { fail(error) }
    if let error = mic.error { warn("mic_failed: \(error)") }
    if ticks % RESCAN_S == 0 {
      // A device that was still settling when the engine restarted gets another try.
      if micAllowed, !engine.isRunning { restartMic() }
      scan()
      let alive = Set(processes().filter(\.isRunningOutput).map(\.object))
      if system.silentFor >= SYSTEM_SILENCE_S, tapped.contains(where: { alive.contains($0.object) }) {
        warn("system_silent_rebuilt")
        rebuild(tapped)
      }
    }
    if mic.silentFor >= MIC_SILENCE_S {
      if !micWarned { warn("mic_silent") }
      micWarned = true
    } else {
      micWarned = false
    }
    writeState("recording")
  }

  private func teardown() {
    engine.stop()
    tap?.stop()
    tap = nil
    mic.close()
    system.close()
    IOPMAssertionRelease(assertion)
  }

  private func finish() {
    teardown()
    writeState("stopped")
    exit(0)
  }

  private func fail(_ message: String) -> Never {
    teardown()
    writeState("failed", error: message)
    exit(1)
  }

  private func writeState(_ status: String, error: String? = nil) {
    let state: [String: Any] = [
      "status": status,
      "pid": ProcessInfo.processInfo.processIdentifier,
      "startedAt": ISO8601DateFormatter().string(from: startedAt),
      "chunks": ["mic": mic.chunks, "system": system.chunks],
      "processes": tapped.map { ["pid": Int($0.pid), "bundleId": $0.bundleId] },
      "warnings": warnings,
      "error": error as Any? ?? NSNull(),
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]), data != lastState else { return }
    lastState = data
    let tmp = dir.appendingPathComponent("state.json.tmp").path
    if FileManager.default.createFile(atPath: tmp, contents: data) {
      rename(tmp, dir.appendingPathComponent("state.json").path)
    }
  }
}

// MARK: Commands

func option(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}

switch CommandLine.arguments.dropFirst().first {
case "probe":
  let list = processes().map { p -> [String: Any] in
    ["pid": Int(p.pid), "bundleId": p.bundleId, "isRunningOutput": p.isRunningOutput, "isRunningInput": p.isRunningInput]
  }
  emit(["ok": true, "data": ["processes": list]])
case "record":
  guard let dir = option("--dir"), dir.hasPrefix("/"), let prefix = option("--bundle"), !prefix.isEmpty,
    let seconds = Int(option("--chunk-seconds") ?? "300"), seconds > 0
  else { emit(["ok": false, "reason": "usage: record --dir <abs path> --bundle <bundle id prefix> [--chunk-seconds n]"]) }
  let root = URL(fileURLWithPath: dir)
  try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  let recorder = Recorder(dir: root, prefix: prefix, chunkSeconds: seconds)
  recorder.announce()
  // The first recording asks for the microphone; the system audio tap asks when it is created.
  let granted = DispatchSemaphore(value: 0)
  var allowed = false
  AVCaptureDevice.requestAccess(for: .audio) { allowed = $0; granted.signal() }
  granted.wait()
  recorder.run(micAllowed: allowed)
default:
  emit(["ok": false, "reason": "usage: probe | record"])
}
