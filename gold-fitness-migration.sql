CREATE TABLE IF NOT EXISTS fitness_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  height_inches INTEGER,
  weight_lbs DECIMAL(6,2),
  age INTEGER,
  goal_physique TEXT,
  target_weight_lbs DECIMAL(6,2),
  experience_level TEXT CHECK (experience_level IN ('beginner', 'intermediate', 'advanced')),
  injuries TEXT[],
  available_equipment TEXT[],
  days_per_week INTEGER,
  minutes_per_session INTEGER,
  fitness_goal TEXT CHECK (fitness_goal IN ('recomp', 'bulk', 'cut', 'athletic')),
  onboarding_complete BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS fitness_routines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  is_preset BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fitness_days (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id UUID NOT NULL REFERENCES fitness_routines(id) ON DELETE CASCADE,
  day_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fitness_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id UUID NOT NULL REFERENCES fitness_days(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fitness_exercises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id UUID NOT NULL REFERENCES fitness_sections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sets INTEGER,
  reps_min INTEGER,
  reps_max INTEGER,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fitness_workout_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_id UUID REFERENCES fitness_days(id) ON DELETE SET NULL,
  day_title TEXT,
  logged_date DATE NOT NULL DEFAULT CURRENT_DATE,
  completed_at TIMESTAMPTZ,
  duration_minutes INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fitness_set_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  log_id UUID NOT NULL REFERENCES fitness_workout_logs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exercise_id UUID REFERENCES fitness_exercises(id) ON DELETE SET NULL,
  exercise_name TEXT NOT NULL,
  weight_lbs DECIMAL(8,2) DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  is_counted BOOLEAN DEFAULT FALSE,
  logged_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fitness_body_weight_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weight_lbs DECIMAL(6,2) NOT NULL,
  logged_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, logged_date)
);

CREATE TABLE IF NOT EXISTS fitness_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  milestone_type TEXT NOT NULL,
  achieved_at TIMESTAMPTZ DEFAULT NOW(),
  total_lbs_at_achievement DECIMAL(16,2)
);

CREATE INDEX IF NOT EXISTS idx_fitness_profiles_user ON fitness_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_fitness_routines_user ON fitness_routines(user_id);
CREATE INDEX IF NOT EXISTS idx_fitness_days_routine ON fitness_days(routine_id);
CREATE INDEX IF NOT EXISTS idx_fitness_sections_day ON fitness_sections(day_id);
CREATE INDEX IF NOT EXISTS idx_fitness_exercises_section ON fitness_exercises(section_id);
CREATE INDEX IF NOT EXISTS idx_fitness_workout_logs_user ON fitness_workout_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_fitness_workout_logs_date ON fitness_workout_logs(logged_date);
CREATE INDEX IF NOT EXISTS idx_fitness_set_logs_user ON fitness_set_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_fitness_set_logs_log ON fitness_set_logs(log_id);
CREATE INDEX IF NOT EXISTS idx_fitness_set_logs_exercise ON fitness_set_logs(exercise_name);
CREATE INDEX IF NOT EXISTS idx_fitness_body_weight_user ON fitness_body_weight_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_fitness_milestones_user ON fitness_milestones(user_id);
