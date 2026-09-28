import SwiftUI

struct RootView: View {
  @EnvironmentObject private var workout: WorkoutManager

  var body: some View {
    switch workout.phase {
    case .running, .paused, .saving:
      RunningView()
    default:
      StartView()
    }
  }
}

/** Before a run: this week and the league, and two ways to start. */
struct StartView: View {
  @EnvironmentObject private var workout: WorkoutManager
  @EnvironmentObject private var phone: PhoneLink

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 10) {
        if let active = phone.context.activeDays {
          Text(phone.context.goalDays.map { "\(active) of \($0) days" } ?? "\(active) active days")
            .font(.headline)
            .foregroundStyle(Palette.text)
        }
        if let rank = phone.context.leagueRank {
          Text("#\(rank) in \(phone.context.leagueName ?? "your league")")
            .font(.footnote)
            .foregroundStyle(Palette.secondary)
        }
        if workout.phase == .saved {
          Label("Run saved. It syncs through your iPhone.", systemImage: "checkmark.circle")
            .font(.footnote)
            .foregroundStyle(Palette.lime)
        }
        if let error = workout.lastError {
          Text(error)
            .font(.footnote)
            .foregroundStyle(.orange)
        }
        Button {
          Task { await workout.start(indoor: false) }
        } label: {
          Label("Outdoor run", systemImage: "figure.run")
            .frame(maxWidth: .infinity)
        }
        .tint(Palette.lime)
        .foregroundStyle(Palette.background)
        .disabled(workout.phase == .starting)
        .accessibilityHint("Starts recording a run with GPS")

        Button {
          Task { await workout.start(indoor: true) }
        } label: {
          Label("Treadmill", systemImage: "figure.run.treadmill")
            .frame(maxWidth: .infinity)
        }
        .disabled(workout.phase == .starting)
        .accessibilityHint("Starts recording an indoor run")
      }
      .padding(.horizontal, 4)
    }
    .navigationTitle("PaceLeague")
  }
}

/**
 * During a run: time, distance, pace and heart rate. Pausing takes a press and hold, so a sleeve or
 * a wet wrist can't stop the run by accident (Nike Run Club's most common watch complaint).
 */
struct RunningView: View {
  @EnvironmentObject private var workout: WorkoutManager
  @EnvironmentObject private var phone: PhoneLink
  @State private var confirmEnd = false

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      let elapsed = workout.elapsed(at: context.date)
      let units = phone.context
      VStack(alignment: .leading, spacing: 2) {
        Text(clockText(elapsed))
          .font(.system(size: 40, weight: .semibold, design: .rounded).monospacedDigit())
          .foregroundStyle(workout.phase == .paused ? Palette.secondary : Palette.lime)
          .accessibilityLabel("Time \(clockText(elapsed))")
        Text(String(format: "%.2f %@", workout.distanceM / units.metresPerUnit, units.unitLabel))
          .font(.system(size: 26, weight: .semibold, design: .rounded).monospacedDigit())
          .foregroundStyle(Palette.text)
        HStack {
          Text("\(paceText(seconds: elapsed, metres: workout.distanceM, metresPerUnit: units.metresPerUnit)) /\(units.unitLabel)")
          Spacer()
          if let bpm = workout.heartRate {
            Label("\(Int(bpm.rounded()))", systemImage: "heart.fill")
              .foregroundStyle(.red)
          }
        }
        .font(.system(.body, design: .rounded).monospacedDigit())
        .foregroundStyle(Palette.secondary)

        Spacer(minLength: 4)
        if workout.phase == .saving {
          ProgressView("Saving…")
        } else {
          HoldButton(title: workout.phase == .paused ? "Hold to resume" : "Hold to pause", systemImage: workout.phase == .paused ? "play.fill" : "pause.fill") {
            workout.togglePause()
          }
          if workout.phase == .paused {
            Button(role: .destructive) {
              confirmEnd = true
            } label: {
              Label("End run", systemImage: "stop.fill").frame(maxWidth: .infinity)
            }
          }
        }
      }
      .padding(.horizontal, 4)
    }
    .confirmationDialog("End this run?", isPresented: $confirmEnd) {
      Button("End and save") { workout.end() }
      Button("Keep running", role: .cancel) {}
    }
  }
}

/** A button that acts only after being held for half a second. */
struct HoldButton: View {
  let title: String
  let systemImage: String
  let action: () -> Void
  @State private var pressing = false

  var body: some View {
    Label(title, systemImage: systemImage)
      .frame(maxWidth: .infinity, minHeight: 44)
      .background(RoundedRectangle(cornerRadius: 12).fill(pressing ? Palette.lime.opacity(0.5) : Palette.surface))
      .foregroundStyle(Palette.text)
      .onLongPressGesture(minimumDuration: 0.5, pressing: { pressing = $0 }, perform: action)
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isButton)
      .accessibilityAction { action() }
  }
}
