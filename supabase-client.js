"use strict";

(function () {
    const settings = window.ELibrarySupabaseSettings || {};
    const state = {
        client: null,
        error: ""
    };

    if (!settings.url) {
        state.error =
            "Add your Supabase project URL to supabase-config.js.";
    } else if (!settings.anonKey) {
        state.error =
            "Add your Supabase publishable/anon key to supabase-config.js.";
    } else if (!window.supabase || !window.supabase.createClient) {
        state.error =
            "The Supabase client library could not be loaded. Check your internet connection and reload.";
    } else {
        try {
            state.client = window.supabase.createClient(
                settings.url,
                settings.anonKey
            );
        } catch (error) {
            state.error = `Supabase configuration is invalid: ${error.message}`;
            console.error(error);
        }
    }

    window.ELibrarySupabase = state;
})();
