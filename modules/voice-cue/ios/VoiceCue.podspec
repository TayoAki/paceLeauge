Pod::Spec.new do |s|
  s.name           = 'VoiceCue'
  s.version        = '1.0.0'
  s.summary        = 'Run voice cues that lower other audio while they speak.'
  s.description    = 'Speaks PaceLeague run cues over the runner\'s music, ducking it for the length of the cue and handing the audio back afterwards.'
  s.license        = { :type => 'Proprietary' }
  s.author         = 'PaceLeague'
  s.homepage       = 'https://github.com/TayoAki/paceLeauge'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/TayoAki/paceLeauge.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }
end
