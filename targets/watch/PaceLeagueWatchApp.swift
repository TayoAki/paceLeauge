import SwiftUI

@main
struct PaceLeagueWatchApp: App {
  @StateObject private var phone: PhoneLink
  @StateObject private var workout: WorkoutManager

  init() {
    let phone = PhoneLink()
    _phone = StateObject(wrappedValue: phone)
    _workout = StateObject(wrappedValue: WorkoutManager(phone: phone))
  }

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(phone)
        .environmentObject(workout)
        .task { phone.activate() }
    }
  }
}
