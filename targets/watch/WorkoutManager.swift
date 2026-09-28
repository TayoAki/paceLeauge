import CoreLocation
import Foundation
import HealthKit
import WatchKit

/**
 * One run on the watch (docs/ROADMAP.md 2.2): an HKWorkoutSession with a live builder for distance,
 * heart rate and steps, and a route builder fed by the watch's own GPS. At the end the workout is
 * saved to Apple Health (with the run's PaceLeague id in its metadata) and a run file goes to the
 * phone by WatchConnectivity. Either way the phone saves it under the same id, so it counts once.
 */
@MainActor
final class WorkoutManager: NSObject, ObservableObject {
  enum Phase: Equatable {
    case idle, starting, running, paused, saving, saved, failed
  }

  @Published private(set) var phase: Phase = .idle
  @Published private(set) var distanceM: Double = 0
  @Published private(set) var heartRate: Double?
  @Published private(set) var indoor = false
  @Published private(set) var lastError: String?

  let store = HKHealthStore()
  private var session: HKWorkoutSession?
  private var builder: HKLiveWorkoutBuilder?
  private var routeBuilder: HKWorkoutRouteBuilder?
  private let location = CLLocationManager()
  private let cues = CueSpeaker()
  private let phone: PhoneLink

  // The run as the phone will see it.
  private var runId = UUID()
  private var startedAt = Date()
  private var segments: [(start: Date, end: Date?)] = []
  private var points: [[Double]] = []
  private var nextCueM: Double = 1000
  private var lastMirrorAt = Date.distantPast

  init(phone: PhoneLink) {
    self.phone = phone
    super.init()
    location.delegate = self
    location.activityType = .fitness
    location.desiredAccuracy = kCLLocationAccuracyBest
    location.distanceFilter = kCLDistanceFilterNone
  }

  func elapsed(at date: Date) -> TimeInterval {
    builder?.elapsedTime(at: date) ?? 0
  }

  private func requestAuthorization() async throws {
    let share: Set<HKSampleType> = [HKObjectType.workoutType(), HKSeriesType.workoutRoute()]
    let read: Set<HKObjectType> = [
      HKQuantityType(.heartRate), HKQuantityType(.distanceWalkingRunning), HKQuantityType(.stepCount),
      HKQuantityType(.activeEnergyBurned), HKObjectType.workoutType(), HKSeriesType.workoutRoute(),
    ]
    try await store.requestAuthorization(toShare: share, read: read)
  }

  func start(indoor: Bool) async {
    guard phase == .idle || phase == .saved || phase == .failed else { return }
    phase = .starting
    lastError = nil
    do {
      try await requestAuthorization()
      if !indoor {
        location.requestWhenInUseAuthorization()
      }
      let configuration = HKWorkoutConfiguration()
      configuration.activityType = .running
      configuration.locationType = indoor ? .indoor : .outdoor
      let session = try HKWorkoutSession(healthStore: store, configuration: configuration)
      let builder = session.associatedWorkoutBuilder()
      let source = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: configuration)
      source.enableCollection(for: HKQuantityType(.stepCount), predicate: nil)
      builder.dataSource = source
      session.delegate = self
      builder.delegate = self

      self.session = session
      self.builder = builder
      self.indoor = indoor
      routeBuilder = indoor ? nil : HKWorkoutRouteBuilder(healthStore: store, device: nil)
      runId = UUID()
      distanceM = 0
      heartRate = nil
      points = []
      segments = []
      nextCueM = phone.context.metresPerUnit

      let now = Date()
      startedAt = now
      session.startActivity(with: now)
      try await builder.beginCollection(at: now)
      if !indoor {
        location.startUpdatingLocation()
      }
      // Shows the run on the phone (and its Live Activity) while it lasts.
      try? await session.startMirroringToCompanionDevice()
    } catch {
      lastError = error.localizedDescription
      phase = .failed
      reset()
    }
  }

  func togglePause() {
    switch phase {
    case .running: session?.pause()
    case .paused: session?.resume()
    default: break
    }
  }

  func end() {
    guard phase == .running || phase == .paused else { return }
    phase = .saving
    session?.end()
  }

  /** After the session ends: close the builder, save the workout and its route, send the run to the phone. */
  private func finish(at date: Date) async {
    guard let builder else { return }
    location.stopUpdatingLocation()
    if let last = segments.indices.last, segments[last].end == nil {
      segments[last].end = date
    }
    do {
      try await builder.endCollection(at: date)
      try await builder.addMetadata([
        HKMetadataKeyIndoorWorkout: NSNumber(value: indoor),
        HKMetadataKeyExternalUUID: runId.uuidString,
        "PaceLeagueRunID": runId.uuidString,
      ])
      let workout = try await builder.finishWorkout()
      if let workout, let routeBuilder {
        try? await routeBuilder.finishRoute(with: workout, metadata: nil)
      }
      phone.send(run: runFile(endedAt: date, builder: builder))
      phase = .saved
      WKInterfaceDevice.current().play(.success)
    } catch {
      // Health refused, but the phone can still have the run.
      phone.send(run: runFile(endedAt: date, builder: builder))
      lastError = error.localizedDescription
      phase = .failed
    }
    reset()
  }

  private func runFile(endedAt: Date, builder: HKLiveWorkoutBuilder) -> WatchRunFile {
    let heart = builder.statistics(for: HKQuantityType(.heartRate))
    let bpm = HKUnit.count().unitDivided(by: .minute())
    let steps = builder.statistics(for: HKQuantityType(.stepCount))?.sumQuantity()?.doubleValue(for: .count())
    return WatchRunFile(
      version: 1,
      runId: runId.uuidString.lowercased(),
      startedAt: startedAt.timeIntervalSince1970 * 1000,
      endedAt: endedAt.timeIntervalSince1970 * 1000,
      segments: segments.map { [$0.start.timeIntervalSince1970 * 1000, ($0.end ?? endedAt).timeIntervalSince1970 * 1000] },
      points: points,
      distanceM: distanceM,
      indoor: indoor,
      avgHeartRate: heart?.averageQuantity()?.doubleValue(for: bpm),
      maxHeartRate: heart?.maximumQuantity()?.doubleValue(for: bpm),
      steps: steps,
      device: WKInterfaceDevice.current().model
    )
  }

  private func reset() {
    session = nil
    builder = nil
    routeBuilder = nil
  }

  /** Voice cues at each kilometer or mile, and the live numbers for the phone. */
  private func distanceChanged() {
    let context = phone.context
    if context.cues, distanceM >= nextCueM {
      let units = Int((distanceM / context.metresPerUnit).rounded(.down))
      let pace = paceText(seconds: elapsed(at: Date()), metres: distanceM, metresPerUnit: context.metresPerUnit)
      cues.say("\(units) \(context.unitWord)\(units == 1 ? "" : "s"). Pace \(pace).")
      nextCueM = Double(units + 1) * context.metresPerUnit
    }
    mirror()
  }

  private func mirror() {
    guard let session, Date().timeIntervalSince(lastMirrorAt) >= 5 else { return }
    lastMirrorAt = Date()
    let state: [String: Any] = [
      "state": phase == .paused ? "paused" : "running",
      "elapsed_s": elapsed(at: Date()),
      "distance_m": distanceM,
      "heart_rate": heartRate ?? NSNull(),
      "indoor": indoor,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: state) else { return }
    Task { try? await session.sendToRemoteWorkoutSession(data: data) }
  }
}

extension WorkoutManager: HKWorkoutSessionDelegate {
  nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState, from fromState: HKWorkoutSessionState, date: Date) {
    Task { @MainActor in
      switch toState {
      case .running:
        segments.append((start: date, end: nil))
        phase = .running
      case .paused:
        if let last = segments.indices.last, segments[last].end == nil {
          segments[last].end = date
        }
        phase = .paused
      case .ended:
        await finish(at: date)
      default:
        break
      }
      lastMirrorAt = .distantPast
      mirror()
    }
  }

  nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
    Task { @MainActor in
      lastError = error.localizedDescription
    }
  }

  nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didReceiveDataFromRemoteWorkoutSession data: [Data]) {}
}

extension WorkoutManager: HKLiveWorkoutBuilderDelegate {
  nonisolated func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}

  nonisolated func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>) {
    let distance = workoutBuilder.statistics(for: HKQuantityType(.distanceWalkingRunning))?.sumQuantity()?.doubleValue(for: .meter())
    let heart = workoutBuilder.statistics(for: HKQuantityType(.heartRate))?.mostRecentQuantity()?.doubleValue(for: HKUnit.count().unitDivided(by: .minute()))
    Task { @MainActor in
      if let distance { distanceM = distance }
      if let heart { heartRate = heart }
      distanceChanged()
    }
  }
}

extension WorkoutManager: CLLocationManagerDelegate {
  nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    // Only fixes good enough to measure with, as on the phone.
    let usable = locations.filter { $0.horizontalAccuracy >= 0 && $0.horizontalAccuracy <= 50 }
    guard !usable.isEmpty else { return }
    Task { @MainActor in
      guard phase == .running else { return }
      try? await routeBuilder?.insertRouteData(usable)
      for fix in usable {
        points.append([fix.timestamp.timeIntervalSince1970 * 1000, fix.coordinate.latitude, fix.coordinate.longitude, fix.horizontalAccuracy])
      }
    }
  }
}
