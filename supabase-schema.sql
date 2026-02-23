-- =============================================================================
-- Photo Describer — Supabase Database Schema
-- =============================================================================
-- Run this script in the Supabase SQL editor (Settings > SQL Editor) to create
-- all tables, indexes, and Row Level Security (RLS) policies.
-- =============================================================================

-- Enable the pgcrypto extension for UUID generation (usually already enabled)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- TABLE: profiles
-- One row per authenticated user; extends the built-in auth.users table.
-- Created automatically by the trigger below when a user signs up.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
    id                           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name                    TEXT,

    -- Stripe identifiers
    stripe_customer_id           TEXT UNIQUE,
    stripe_subscription_id       TEXT UNIQUE,

    -- Subscription state
    -- plan values: 'none' | 'starter' | 'growth' | 'business'
    subscription_plan            TEXT NOT NULL DEFAULT 'none',
    -- status values: 'inactive' | 'active' | 'past_due' | 'cancelled'
    subscription_status          TEXT NOT NULL DEFAULT 'inactive',

    -- Usage tracking
    descriptions_used_this_cycle INTEGER NOT NULL DEFAULT 0,
    monthly_description_limit    INTEGER NOT NULL DEFAULT 0,
    cycle_reset_date             TIMESTAMPTZ,

    -- Pay-as-you-go credits
    credits_balance              INTEGER NOT NULL DEFAULT 0,

    created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for Stripe webhook lookups by customer ID
CREATE INDEX IF NOT EXISTS idx_profiles_stripe_customer_id
    ON public.profiles (stripe_customer_id);

-- =============================================================================
-- TABLE: brand_voices
-- Stores each user's brand voice settings (tone + example descriptions).
-- One row per user, upserted via the brand-voice API endpoint.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.brand_voices (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,

    tone_description     TEXT NOT NULL,

    -- Array of example product descriptions the user wants to match in style
    example_descriptions TEXT[] NOT NULL DEFAULT '{}',

    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast single-user lookups
CREATE INDEX IF NOT EXISTS idx_brand_voices_user_id
    ON public.brand_voices (user_id);

-- =============================================================================
-- TABLE: generations
-- Stores every AI generation request for history and analytics.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.generations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

    -- Platform the content was generated for
    platform      TEXT NOT NULL
                  CHECK (platform IN ('ebay', 'etsy', 'amazon', 'shopify', 'generic')),

    -- Whether the input was a photo, plain text, or part of a bulk job
    input_type    TEXT NOT NULL DEFAULT 'text'
                  CHECK (input_type IN ('photo', 'text', 'bulk')),

    -- Contextual product data supplied with the request
    input_context JSONB,

    -- The structured output returned by Claude
    output        JSONB NOT NULL,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for user history queries (most common access pattern)
CREATE INDEX IF NOT EXISTS idx_generations_user_id_created_at
    ON public.generations (user_id, created_at DESC);

-- Index to allow filtering by platform alongside user_id
CREATE INDEX IF NOT EXISTS idx_generations_user_id_platform
    ON public.generations (user_id, platform);

-- =============================================================================
-- TABLE: bulk_jobs
-- Optional table for tracking bulk generation jobs as a whole unit.
-- The individual row results are stored as a JSONB array.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.bulk_jobs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

    platform    TEXT NOT NULL
                CHECK (platform IN ('ebay', 'etsy', 'amazon', 'shopify', 'generic')),

    -- Summary counters
    total_rows  INTEGER NOT NULL DEFAULT 0,
    succeeded   INTEGER NOT NULL DEFAULT 0,
    failed      INTEGER NOT NULL DEFAULT 0,

    -- Full results array: [{row, output, success, error?}]
    results     JSONB NOT NULL DEFAULT '[]',

    -- Job lifecycle: 'pending' | 'processing' | 'complete' | 'failed'
    status      TEXT NOT NULL DEFAULT 'pending',

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bulk_jobs_user_id
    ON public.bulk_jobs (user_id, created_at DESC);

-- =============================================================================
-- FUNCTION + TRIGGER: auto-create profile on signup
-- When a new row is inserted into auth.users, create a matching profile row.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.profiles (id, full_name)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'full_name', NULL)
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

-- Drop and recreate to ensure idempotency
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =============================================================================
-- FUNCTION: auto-update updated_at timestamp
-- =============================================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_profiles_updated_at ON public.profiles;
CREATE TRIGGER set_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_brand_voices_updated_at ON public.brand_voices;
CREATE TRIGGER set_brand_voices_updated_at
    BEFORE UPDATE ON public.brand_voices
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- ROW LEVEL SECURITY (RLS)
-- Enable RLS on all tables and create policies so users can only access
-- their own data.  The API uses the service role key which bypasses RLS,
-- but enabling RLS protects against direct client-side queries using the
-- anon or user JWT tokens.
-- =============================================================================

-- profiles -----------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Users can read and update only their own profile
CREATE POLICY "Users can view own profile"
    ON public.profiles FOR SELECT
    USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id);

-- brand_voices -------------------------------------------------------------
ALTER TABLE public.brand_voices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own brand voice"
    ON public.brand_voices FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own brand voice"
    ON public.brand_voices FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own brand voice"
    ON public.brand_voices FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own brand voice"
    ON public.brand_voices FOR DELETE
    USING (auth.uid() = user_id);

-- generations --------------------------------------------------------------
ALTER TABLE public.generations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own generations"
    ON public.generations FOR SELECT
    USING (auth.uid() = user_id);

-- Users should not be able to insert directly — insertions go via the API
-- using the service role key.

-- bulk_jobs ----------------------------------------------------------------
ALTER TABLE public.bulk_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own bulk jobs"
    ON public.bulk_jobs FOR SELECT
    USING (auth.uid() = user_id);

-- =============================================================================
-- SAMPLE DATA (optional — comment out in production)
-- =============================================================================
-- INSERT INTO public.profiles (id, full_name, subscription_plan, subscription_status, monthly_description_limit)
-- VALUES (
--     '00000000-0000-0000-0000-000000000001',
--     'Test User',
--     'starter',
--     'active',
--     100
-- );
