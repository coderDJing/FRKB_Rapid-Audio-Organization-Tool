pub const HIGHLEVEL_CLASS_ORDER: &[(&str, &[&str])] = &[
  ("culture", &["non_western", "western"]),
  ("danceability", &["danceable", "not_danceable"]),
  ("mood_acoustic", &["acoustic", "not_acoustic"]),
  ("mood_aggressive", &["aggressive", "not_aggressive"]),
  ("mood_electronic", &["electronic", "not_electronic"]),
  ("mood_happy", &["happy", "not_happy"]),
  ("mood_party", &["party", "not_party"]),
  ("mood_relaxed", &["relaxed", "not_relaxed"]),
  ("mood_sad", &["sad", "not_sad"]),
  ("timbre", &["bright", "dark"]),
  ("voice_instrumental", &["instrumental", "voice"]),
  ("tonal_atonal", &["tonal", "atonal"]),
  (
    "genre_dortmund",
    &[
      "alternative",
      "blues",
      "electronic",
      "folkcountry",
      "funksoulrnb",
      "jazz",
      "pop",
      "raphiphop",
      "rock",
    ],
  ),
  ("genre_electronic", &["ambient", "dnb", "house", "techno", "trance"]),
  ("genre_rosamerica", &["cla", "dan", "hip", "jaz", "pop", "rhy", "roc", "spe"]),
  (
    "genre_tzanetakis",
    &["blu", "cla", "cou", "dis", "hip", "jaz", "met", "pop", "reg", "roc"],
  ),
  (
    "mirex_ballroom",
    &[
      "ChaChaCha",
      "Jive",
      "Quickstep",
      "Rumba-American",
      "Rumba-International",
      "Rumba-Misc",
      "Samba",
      "Tango",
      "VienneseWaltz",
      "Waltz",
    ],
  ),
  ("moods_mirex", &["Cluster1", "Cluster2", "Cluster3", "Cluster4", "Cluster5"]),
];

pub const RHYTHM_FEATURE_ORDER: &[&str] = &[
  "perceptual_tempo",
  "onset_rate",
  "beats_loudness_mean",
  "bpm_confidence",
  "bpm_histogram_first_peak",
  "bpm_histogram_first_peak_weight",
  "bpm_histogram_first_peak_spread",
  "bpm_histogram_second_peak",
  "bpm_histogram_second_peak_weight",
  "bpm_histogram_second_peak_spread",
];

pub const TONAL_FEATURE_ORDER: &[&str] = &[
  "key_strength",
  "chords_changes_rate",
  "chords_number_rate",
  "chords_strength",
];

pub const LOWLEVEL_FEATURE_ORDER: &[&str] = &[
  "average_loudness",
  "dynamic_complexity",
  "dissonance_mean",
  "spectral_centroid_mean",
  "spectral_flux_mean",
  "spectral_flatness_db_mean",
  "spectral_rolloff_mean",
  "spectral_rms_mean",
];

pub const MFCC_DIM: usize = 13;
pub const GFCC_DIM: usize = 13;

pub fn essentia_feature_names() -> Vec<String> {
  let mut names: Vec<String> = Vec::new();
  for (group, classes) in HIGHLEVEL_CLASS_ORDER {
    for class in *classes {
      names.push(format!("hl.{}.{}", group, class));
    }
  }

  for key in RHYTHM_FEATURE_ORDER {
    names.push(format!("rhythm.{}", key));
  }
  for key in TONAL_FEATURE_ORDER {
    names.push(format!("tonal.{}", key));
  }
  for key in LOWLEVEL_FEATURE_ORDER {
    names.push(format!("lowlevel.{}", key));
  }
  for i in 0..MFCC_DIM {
    names.push(format!("lowlevel.mfcc_mean_{}", i));
  }
  for i in 0..GFCC_DIM {
    names.push(format!("lowlevel.gfcc_mean_{}", i));
  }

  names
}

pub fn essentia_feature_count() -> usize {
  let mut count = 0usize;
  for (_group, classes) in HIGHLEVEL_CLASS_ORDER {
    count += classes.len();
  }
  count += RHYTHM_FEATURE_ORDER.len();
  count += TONAL_FEATURE_ORDER.len();
  count += LOWLEVEL_FEATURE_ORDER.len();
  count += MFCC_DIM;
  count += GFCC_DIM;
  count
}
