// Supabase Configuration
const SUPABASE_URL = "https://gslrdrpoihstzxspgagn.supabase.co";
const SUPABASE_KEY = "sb_publishable_9t_6D9kuxVdBkp22JKQdgA_iOs7SO1Z";

let supabaseClient = null;
let currentUser = null;
let syncStatus = 'local'; // 'local' | 'synced' | 'syncing' | 'offline' | 'error'
let isOfflinePendingSync = false;
let syncDebounceTimeout = null;

// Initialize Supabase Client
function initSupabase() {
    try {
        if (window.supabase && window.supabase.createClient) {
            supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
                auth: {
                    persistSession: true,
                    autoRefreshToken: true,
                    detectSessionInUrl: true
                }
            });
            setupSupabaseAuth();
        } else {
            console.warn("Supabase library not loaded yet.");
        }
    } catch(e) {
        console.error("Supabase init error:", e);
    }
}

// Clean Default Athlete Profile (No personal information)
const DEFAULT_DATA = {
    profile: {
        age: 28,
        event: "Half Ironman",
        targetTime: "5:30:00",
        raceDate: "",
        planStartDate: new Date().toISOString().slice(0, 10),
        currentWeek: 1,
        hasSeenGuide: false,
        stats: { swim: "2km in 42min", bike: "32kph flat", run: "5K in 21:00" },
        gear: { bike: "Canyon Aeroad CF SLX", shoes: "Adidas Adizero Evo SL", watch: "Garmin Forerunner 965" },
        limitations: "", 
        availability: { mon: 45, tue: 60, wed: 60, thu: 60, fri: 45, sat: 180, sun: 180 }
    },
    runs: [],
    customEvents: [],
    customCategories: [], 
    completedWorkouts: {},
    plan: null,
    exerciseDB: {},
    lastModified: Date.now()
};

let appData = loadData();
let currentPromptMode = 'initial'; 

// Calendar state
let currentDate = new Date();
let currentMonth = currentDate.getMonth();
let currentYear = currentDate.getFullYear();
let selectedDateStr = new Date().toISOString().slice(0,10);

// Storage Management with Cookie Fallback
function setStorageItem(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch(e) {
        document.cookie = key + "=" + encodeURIComponent(value) + "; path=/; max-age=31536000";
    }
}

function getStorageItem(key) {
    try {
        const val = localStorage.getItem(key);
        if (val) return val;
    } catch(e) {}
    
    const nameEQ = key + "=";
    const ca = document.cookie.split(';');
    for(let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) === ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) === 0) return decodeURIComponent(c.substring(nameEQ.length, c.length));
    }
    return null;
}

function loadData() {
    const saved = getStorageItem('trit_data');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            return deepMerge(DEFAULT_DATA, parsed);
        } catch(e) { return JSON.parse(JSON.stringify(DEFAULT_DATA)); }
    }
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

function deepMerge(target, source) {
    if (!isObject(target) || !isObject(source)) {
        return source !== undefined ? source : target;
    }
    let output = Object.assign({}, target);
    Object.keys(source).forEach(key => {
        if (isObject(source[key])) {
            if (!(key in target) || !isObject(target[key])) {
                output[key] = source[key];
            } else {
                output[key] = deepMerge(target[key], source[key]);
            }
        } else {
            output[key] = source[key];
        }
    });
    return output;
}

function isObject(item) { return (item && typeof item === 'object' && !Array.isArray(item)); }

// Save locally and trigger cloud synchronization on every interaction
function saveData(skipCloudSync = false) { 
    try {
        appData.lastModified = Date.now();
        setStorageItem('trit_data', JSON.stringify(appData)); 
        if (!skipCloudSync) {
            scheduleCloudSync();
        }
    } catch(e) {
        console.error("Failed to save local data:", e);
    }
}

// Auto-save on page hide/unload (Safari iOS tab closing & navigation fix)
window.addEventListener('beforeunload', () => saveData(true));
window.addEventListener('pagehide', () => saveData(true));

// Supabase Auth and Cloud Synchronization
async function setupSupabaseAuth() {
    if (!supabaseClient) return;

    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session && session.user) {
            currentUser = session.user;
            updateSyncStatusUI('synced');
            updateProfileSettingsUI();
            // Pull newest cloud state in the background
            handleUserLoginSync();
        } else {
            currentUser = null;
            updateSyncStatusUI('local');
            updateProfileSettingsUI();
        }
    } catch (e) {
        console.warn("Session retrieval note:", e);
    }

    // Handle Auth state change & email confirmation redirects
    supabaseClient.auth.onAuthStateChange(async (event, session) => {
        console.log("Auth state change:", event, session);
        if (session && session.user) {
            const isNewLogin = (!currentUser || currentUser.id !== session.user.id);
            currentUser = session.user;
            
            if (event === 'SIGNED_IN' && isNewLogin) {
                showToast(`Welcome, ${session.user.email}!`);
                await handleUserLoginSync();
            } else if (event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') {
                updateSyncStatusUI('synced');
            }
            updateProfileSettingsUI();
        } else {
            currentUser = null;
            updateSyncStatusUI('local');
            updateProfileSettingsUI();
        }
    });

    // Check URL parameters for confirmation flags or errors
    if (window.location.hash) {
        const hashStr = window.location.hash.substring(1);
        const hashParams = new URLSearchParams(hashStr);
        if (hashParams.get('error')) {
            const errDesc = hashParams.get('error_description') || 'Authentication issue';
            setTimeout(() => {
                const authMsg = document.getElementById('authNoticeBox');
                if (authMsg) {
                    authMsg.className = 'notice-box warning';
                    authMsg.innerHTML = `
                        <div style="font-weight:700; margin-bottom:4px;">Authentication Notice</div>
                        <div>${decodeURIComponent(errDesc.replace(/\+/g, ' '))}.</div>
                    `;
                    authMsg.style.display = 'block';
                    openProfileModal('settings');
                }
            }, 500);
        } else if (hashParams.get('access_token')) {
            showToast("Email confirmed! Connected to Supabase.");
        }
    }
}

// When logging in: Fetch user state from Supabase (user_metadata + user_data table), overwrite local state
async function handleUserLoginSync() {
    if (!supabaseClient || !currentUser) return;
    updateSyncStatusUI('syncing');

    try {
        // 1. Refresh currentUser to ensure we have the absolute latest user_metadata from server
        try {
            const { data: userData } = await supabaseClient.auth.getUser();
            if (userData && userData.user) {
                currentUser = userData.user;
            }
        } catch (uErr) {
            console.warn("User refresh note:", uErr);
        }

        let remoteData = null;
        let remoteTimestamp = 0;

        // Check user_metadata (natively supported on ALL Supabase instances without needing any SQL tables)
        if (currentUser && currentUser.user_metadata && currentUser.user_metadata.trit_payload) {
            remoteData = currentUser.user_metadata.trit_payload;
            remoteTimestamp = currentUser.user_metadata.trit_last_sync || remoteData.lastModified || 0;
        }

        // Also check user_data table if the table exists in user's Supabase database
        try {
            const { data: tableRow, error: tableErr } = await supabaseClient
                .from('user_data')
                .select('*')
                .eq('user_id', currentUser.id)
                .maybeSingle();

            if (!tableErr && tableRow && (tableRow.data || tableRow.payload)) {
                const tablePayload = tableRow.data || tableRow.payload;
                const tableTime = new Date(tableRow.updated_at || 0).getTime() || tablePayload.lastModified || 0;
                if (tableTime >= remoteTimestamp || !remoteData) {
                    remoteData = tablePayload;
                    remoteTimestamp = tableTime;
                }
            }
        } catch (tblErr) {
            // Table doesn't exist - this is expected if user didn't run SQL DDL
        }

        const localTime = appData.lastModified || 0;
        const localHasData = (appData.runs && appData.runs.length > 0) || 
                             (appData.customEvents && appData.customEvents.length > 0) ||
                             (appData.plan && appData.plan.weeks && appData.plan.weeks.length > 0) ||
                             (appData.profile && appData.profile.age && appData.profile.age !== 28);

        if (remoteData) {
            // Remote has data!
            // If remote is newer, or if this device only had fresh default data, restore remote state:
            if (remoteTimestamp >= localTime || !localHasData) {
                appData = deepMerge(DEFAULT_DATA, remoteData);
                appData.lastModified = Math.max(remoteTimestamp, Date.now());
                setStorageItem('trit_data', JSON.stringify(appData));
                renderAllPages();
                showToast("Cloud data synchronized!");
            } else {
                // Local state was modified offline with newer changes; sync up to cloud!
                await syncToSupabase();
                showToast("Local updates saved to cloud!");
            }
            updateSyncStatusUI('synced');
            updateLastSyncTextUI();
        } else {
            // First time login on empty cloud account: push existing local state to cloud!
            await syncToSupabase();
            updateSyncStatusUI('synced');
            updateLastSyncTextUI();
        }
    } catch (e) {
        console.error("Error during login sync:", e);
        updateSyncStatusUI('error');
    }
}

// Schedule debounced cloud sync
function scheduleCloudSync() {
    if (!supabaseClient || !currentUser) {
        updateSyncStatusUI('local');
        return;
    }

    if (!navigator.onLine) {
        isOfflinePendingSync = true;
        updateSyncStatusUI('offline');
        return;
    }

    updateSyncStatusUI('syncing');
    if (syncDebounceTimeout) clearTimeout(syncDebounceTimeout);
    
    syncDebounceTimeout = setTimeout(async () => {
        await syncToSupabase();
    }, 600);
}

// Upsert state directly to user_metadata and optionally to table "user_data"
async function syncToSupabase() {
    if (!supabaseClient || !currentUser) return;

    if (!navigator.onLine) {
        isOfflinePendingSync = true;
        updateSyncStatusUI('offline');
        return;
    }

    try {
        updateSyncStatusUI('syncing');
        const now = Date.now();
        appData.lastModified = now;

        // 1. Primary: Save directly to Supabase Auth user_metadata
        // Guaranteed to work across all projects without needing any SQL migrations
        const { data: updatedUser, error: metaErr } = await supabaseClient.auth.updateUser({
            data: {
                trit_payload: appData,
                trit_last_sync: now,
                updated_at: new Date().toISOString()
            }
        });

        if (metaErr) {
            console.warn("Metadata update note:", metaErr.message);
        } else if (updatedUser && updatedUser.user) {
            currentUser = updatedUser.user;
        }

        // 2. Secondary: If table user_data exists, upsert there too
        try {
            await supabaseClient
                .from('user_data')
                .upsert({
                    user_id: currentUser.id,
                    data: appData,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'user_id' });
        } catch (tblErr) {
            // Table might not exist; safe to ignore
        }

        isOfflinePendingSync = false;
        updateSyncStatusUI('synced');
        updateLastSyncTextUI();
    } catch (e) {
        console.error("Sync error:", e);
        updateSyncStatusUI('error');
    }
}

function updateLastSyncTextUI() {
    const el = document.getElementById('settingsLastSyncText');
    if (el) {
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        el.textContent = `● Status: Cloud Synchronized (at ${timeStr})`;
    }
}

async function manualCloudSync() {
    if (!currentUser || !supabaseClient) {
        showToast("Please log in first to sync with the cloud.");
        return;
    }
    showToast("Synchronizing with Supabase...");
    updateSyncStatusUI('syncing');
    await handleUserLoginSync();
    await syncToSupabase();
    showToast("Cloud synchronization complete!");
    updateSyncStatusUI('synced');
}

// Online / Offline Listeners
window.addEventListener('online', () => {
    showToast("Reconnected to internet.");
    if (isOfflinePendingSync && currentUser) {
        syncToSupabase();
    } else if (currentUser) {
        updateSyncStatusUI('synced');
    } else {
        updateSyncStatusUI('local');
    }
});

window.addEventListener('offline', () => {
    isOfflinePendingSync = true;
    updateSyncStatusUI('offline');
    showToast("Offline: changes will sync when reconnected.");
});

function updateSyncStatusUI(status) {
    syncStatus = status;
    const dot = document.getElementById('syncDot');
    const label = document.getElementById('syncLabel');
    if (!dot || !label) return;

    dot.className = 'sync-dot ' + status;
    if (status === 'synced') {
        label.textContent = 'Cloud Synced';
    } else if (status === 'syncing') {
        label.textContent = 'Syncing...';
    } else if (status === 'offline') {
        label.textContent = 'Offline (Local)';
    } else if (status === 'error') {
        label.textContent = 'Sync Issue';
    } else {
        label.textContent = 'Local Mode';
    }
}

// Auth Actions: Sign In, Sign Up, Sign Out
async function authSignUp(email, password) {
    if (!supabaseClient) {
        showToast("Supabase client not ready.");
        return;
    }
    if (!email || !password) {
        showToast("Please enter both email and password.");
        return;
    }
    if (password.length < 6) {
        showToast("Password must be at least 6 characters.");
        return;
    }

    const authMsg = document.getElementById('authNoticeBox');
    if (authMsg) {
        authMsg.className = 'notice-box info';
        authMsg.innerHTML = 'Creating account & syncing data...';
        authMsg.style.display = 'block';
    }

    const currentRedirectUrl = window.location.href.split('#')[0].split('?')[0];

    try {
        const { data, error } = await supabaseClient.auth.signUp({
            email: email.trim(),
            password: password,
            options: {
                emailRedirectTo: currentRedirectUrl,
                data: {
                    trit_payload: appData,
                    trit_last_sync: Date.now(),
                    updated_at: new Date().toISOString()
                }
            }
        });

        if (error) {
            if (error.message && error.message.toLowerCase().includes('already registered')) {
                if (authMsg) {
                    authMsg.className = 'notice-box warning';
                    authMsg.innerHTML = `
                        <div style="font-weight:700; margin-bottom:4px;">Account already exists</div>
                        <div>This email is already registered. Please click <strong>Log In</strong> above.</div>
                    `;
                    authMsg.style.display = 'block';
                }
                showToast("Account already exists. Please Log In.");
                return;
            }

            if (authMsg) {
                authMsg.className = 'notice-box warning';
                authMsg.innerHTML = `<div style="font-weight:700; margin-bottom:4px;">Registration failed</div><div>${error.message}</div>`;
                authMsg.style.display = 'block';
            }
            showToast(error.message);
            return;
        }

        // Scenario 1: Immediate session returned
        if (data && data.session && data.user) {
            currentUser = data.user;
            await syncToSupabase();
            updateProfileSettingsUI();
            if (authMsg) {
                authMsg.className = 'notice-box success';
                authMsg.innerHTML = `
                    <div style="font-weight:700; color:#6ee7b7; margin-bottom:4px;">Account Created & Logged In!</div>
                    <div style="color:var(--text-primary);">You are logged in and your workouts are synced to the cloud.</div>
                `;
                authMsg.style.display = 'block';
            }
            showToast("Account created & logged in!");
            return;
        }

        // Scenario 2: Attempt immediate sign in in case project auto-confirmed
        try {
            const { data: signInData, error: signInErr } = await supabaseClient.auth.signInWithPassword({
                email: email.trim(),
                password: password
            });
            if (!signInErr && signInData && signInData.session) {
                currentUser = signInData.user;
                await syncToSupabase();
                updateProfileSettingsUI();
                showToast("Account created & logged in!");
                return;
            }
        } catch (autoErr) {}

        // Scenario 3: Email verification is required
        if (authMsg) {
            authMsg.className = 'notice-box warning';
            authMsg.innerHTML = `
                <div style="font-weight:700; color:#f59e0b; margin-bottom:6px;">Verification Link Sent</div>
                <div style="color:var(--text-primary); line-height:1.5;">
                    Account created for <strong style="color:#ffffff;">${email.trim()}</strong>! Please check your email to confirm your account.
                </div>
            `;
            authMsg.style.display = 'block';
        }
        showToast("Please check your email for confirmation link.");
    } catch (e) {
        if (authMsg) {
            authMsg.className = 'notice-box warning';
            authMsg.textContent = e.message || 'Error creating account';
            authMsg.style.display = 'block';
        }
    }
}

async function authSignIn(email, password) {
    if (!supabaseClient) {
        showToast("Supabase client not ready.");
        return;
    }
    if (!email || !password) {
        showToast("Please enter email and password.");
        return;
    }

    const authMsg = document.getElementById('authNoticeBox');
    if (authMsg) {
        authMsg.className = 'notice-box info';
        authMsg.textContent = 'Signing in...';
        authMsg.style.display = 'block';
    }

    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email: email.trim(),
            password: password
        });

        if (error) {
            if (authMsg) {
                authMsg.className = 'notice-box warning';
                if (error.message && error.message.toLowerCase().includes('email not confirmed')) {
                    authMsg.innerHTML = `
                        <div style="font-weight:700; margin-bottom:4px;">Email Not Confirmed</div>
                        <div>Please confirm your email address via the link sent to your inbox.</div>
                    `;
                } else {
                    authMsg.innerHTML = `<div style="font-weight:700; margin-bottom:4px;">Sign In Failed</div><div>${error.message}</div>`;
                }
                authMsg.style.display = 'block';
            }
            showToast(error.message);
            return;
        }

        if (authMsg) {
            authMsg.className = 'notice-box success';
            authMsg.textContent = "Signed in successfully!";
            authMsg.style.display = 'block';
        }
        currentUser = data.user;
        await handleUserLoginSync();
        updateProfileSettingsUI();
        showToast("Logged in successfully!");
    } catch (e) {
        if (authMsg) {
            authMsg.className = 'notice-box warning';
            authMsg.textContent = e.message || 'Login error';
            authMsg.style.display = 'block';
        }
    }
}

async function authSignOut() {
    if (!supabaseClient) return;
    try {
        await supabaseClient.auth.signOut();
        currentUser = null;
        updateSyncStatusUI('local');
        updateProfileSettingsUI();
        showToast("Logged out. Switched to Local Mode.");
    } catch (e) {
        console.error("Sign out error:", e);
    }
}

async function deleteCloudAccountData() {
    if (!currentUser || !supabaseClient) {
        showToast("You are not logged in.");
        return;
    }

    const confirm1 = confirm("Are you sure you want to delete all your cloud data from Supabase? This will wipe your saved plans and logs from the cloud database.");
    if (!confirm1) return;

    try {
        updateSyncStatusUI('syncing');
        
        // 1. Wipe metadata in Supabase Auth
        try {
            await supabaseClient.auth.updateUser({
                data: {
                    trit_payload: null,
                    trit_last_sync: null,
                    updated_at: new Date().toISOString()
                }
            });
        } catch (metaErr) {
            console.warn("Wipe metadata note:", metaErr);
        }

        // 2. Wipe from user_data table if present
        try {
            await supabaseClient
                .from('user_data')
                .delete()
                .eq('user_id', currentUser.id);
        } catch (tblErr) {
            console.warn("Delete table note:", tblErr);
        }

        await supabaseClient.auth.signOut();
        currentUser = null;
        updateSyncStatusUI('local');
        updateProfileSettingsUI();
        showToast("Cloud account data deleted and signed out.");
    } catch(e) {
        showToast("Error deleting cloud data: " + e.message);
    }
}

// Core Initialization
document.addEventListener('DOMContentLoaded', () => {
    initSupabase();
    renderDashboard();
    if (!appData.profile.hasSeenGuide) {
        openGuide();
        appData.profile.hasSeenGuide = true;
        saveData();
    }
    const evDateEl = document.getElementById('evDate');
    if (evDateEl) evDateEl.value = new Date().toISOString().slice(0,10);
    renderCalendar();
    renderSavedCategories();
});

function renderAllPages() {
    renderDashboard();
    renderPlan();
    renderCalendar();
    renderHistory();
    renderSavedCategories();
}

function showPage(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    
    const targetPage = document.getElementById('page-' + pageId);
    if (targetPage) targetPage.classList.add('active');
    
    if (['dashboard', 'plan', 'calendar', 'history', 'prompt'].includes(pageId)) {
        document.querySelectorAll('.nav-btn').forEach(btn => {
            if(btn.textContent.trim().toLowerCase().includes(pageId) || (pageId === 'prompt' && btn.textContent.trim().includes('AI'))) {
                btn.classList.add('active');
            }
        });
    }

    if (pageId === 'dashboard') renderDashboard();
    if (pageId === 'plan') renderPlan();
    if (pageId === 'calendar') renderCalendar();
    if (pageId === 'history') renderHistory();
}

// Profile Section with "You" and "Settings" Subsections
let currentProfileSubtab = 'you';

function openProfileModal(subtab = 'you') {
    currentProfileSubtab = subtab;
    populateProfileForm();
    updateProfileSettingsUI();
    switchProfileSubtab(subtab);
    document.getElementById('profileModal').classList.add('active');
}

function closeProfileModal() {
    document.getElementById('profileModal').classList.remove('active');
}

function switchProfileSubtab(tab) {
    currentProfileSubtab = tab;
    document.getElementById('subtabYou').classList.toggle('active', tab === 'you');
    document.getElementById('subtabSettings').classList.toggle('active', tab === 'settings');
    document.getElementById('profileSectionYou').style.display = tab === 'you' ? 'block' : 'none';
    document.getElementById('profileSectionSettings').style.display = tab === 'settings' ? 'block' : 'none';
}

let currentAthleteStep = 1;

function setAthleteStep(step) {
    currentAthleteStep = Math.max(1, Math.min(4, step));
    for (let i = 1; i <= 4; i++) {
        const pill = document.getElementById(`athStepPill${i}`);
        const content = document.getElementById(`athStepContent${i}`);
        if (pill) {
            pill.classList.toggle('active', i === currentAthleteStep);
            pill.classList.toggle('completed', i < currentAthleteStep);
        }
        if (content) {
            content.style.display = (i === currentAthleteStep) ? 'block' : 'none';
        }
    }

    const btnPrev = document.getElementById('athBtnPrev');
    const btnSkip = document.getElementById('athBtnSkip');
    const btnNext = document.getElementById('athBtnNext');

    if (btnPrev) btnPrev.style.display = currentAthleteStep > 1 ? 'block' : 'none';
    if (btnSkip) btnSkip.style.display = currentAthleteStep < 4 ? 'block' : 'none';
    if (btnNext) {
        btnNext.textContent = currentAthleteStep === 4 ? 'Save Profile' : 'Next';
    }
}

function athleteWizardNext() {
    saveProfileDataStep();
    if (currentAthleteStep < 4) {
        setAthleteStep(currentAthleteStep + 1);
    } else {
        saveProfileForm();
        closeProfileModal();
    }
}

function athleteWizardPrev() {
    saveProfileDataStep();
    if (currentAthleteStep > 1) {
        setAthleteStep(currentAthleteStep - 1);
    }
}

function athleteWizardSkip() {
    saveProfileDataStep();
    if (currentAthleteStep < 4) {
        setAthleteStep(currentAthleteStep + 1);
    } else {
        saveProfileForm();
        closeProfileModal();
    }
}

function saveProfileDataStep() {
    const p = appData.profile;
    const ageEl = document.getElementById('pAge');
    if (ageEl) p.age = parseInt(ageEl.value) || 28;
    const evEl = document.getElementById('pEvent');
    if (evEl) p.event = evEl.value || "Half Ironman";
    const ttEl = document.getElementById('pTargetTime');
    if (ttEl) p.targetTime = ttEl.value || "5:30:00";
    const sdEl = document.getElementById('pPlanStartDate');
    if (sdEl) p.planStartDate = sdEl.value || new Date().toISOString().slice(0,10);
    const rdEl = document.getElementById('pRaceDate');
    if (rdEl) p.raceDate = rdEl.value || "";

    const swimEl = document.getElementById('pSwim');
    if (swimEl) p.stats.swim = swimEl.value;
    const bikeEl = document.getElementById('pBike');
    if (bikeEl) p.stats.bike = bikeEl.value;
    const runEl = document.getElementById('pRun');
    if (runEl) p.stats.run = runEl.value;

    const gBikeEl = document.getElementById('pGearBike');
    if (gBikeEl) p.gear.bike = gBikeEl.value;
    const gShoesEl = document.getElementById('pGearShoes');
    if (gShoesEl) p.gear.shoes = gShoesEl.value;
    const gWatchEl = document.getElementById('pGearWatch');
    if (gWatchEl) p.gear.watch = gWatchEl.value;
    const limEl = document.getElementById('pLimitations');
    if (limEl) p.limitations = limEl.value;

    if (!p.availability) p.availability = {};
    ['mon','tue','wed','thu','fri','sat','sun'].forEach(d => {
        const el = document.getElementById('p' + d.charAt(0).toUpperCase() + d.slice(1));
        if (el) p.availability[d] = parseInt(el.value) || 0;
    });

    saveData();
}

function populateProfileForm() {
    const p = appData.profile;
    const ageEl = document.getElementById('pAge');
    if (ageEl) ageEl.value = p.age || 28;
    const evEl = document.getElementById('pEvent');
    if (evEl) evEl.value = p.event || "Half Ironman";
    const ttEl = document.getElementById('pTargetTime');
    if (ttEl) ttEl.value = p.targetTime || "5:30:00";
    const sdEl = document.getElementById('pPlanStartDate');
    if (sdEl) sdEl.value = p.planStartDate || new Date().toISOString().slice(0,10);
    const rdEl = document.getElementById('pRaceDate');
    if (rdEl) rdEl.value = p.raceDate || "";

    const swimEl = document.getElementById('pSwim');
    if (swimEl) swimEl.value = p.stats.swim || "";
    const bikeEl = document.getElementById('pBike');
    if (bikeEl) bikeEl.value = p.stats.bike || "";
    const runEl = document.getElementById('pRun');
    if (runEl) runEl.value = p.stats.run || "";

    const gBikeEl = document.getElementById('pGearBike');
    if (gBikeEl) gBikeEl.value = p.gear.bike || "Canyon Aeroad CF SLX";
    const gShoesEl = document.getElementById('pGearShoes');
    if (gShoesEl) gShoesEl.value = p.gear.shoes || "Adidas Adizero Evo SL";
    const gWatchEl = document.getElementById('pGearWatch');
    if (gWatchEl) gWatchEl.value = p.gear.watch || "Garmin Forerunner 965";
    const limEl = document.getElementById('pLimitations');
    if (limEl) limEl.value = p.limitations || "";

    const a = p.availability;
    ['mon','tue','wed','thu','fri','sat','sun'].forEach(d => {
        const el = document.getElementById('p' + d.charAt(0).toUpperCase() + d.slice(1));
        if (el) el.value = (a && a[d] !== undefined) ? a[d] : 60;
    });

    setAthleteStep(1);
    calculateWeeksTillRaceUI();
}

function saveProfileForm() {
    saveProfileDataStep();
    showToast("Profile updated!");
    renderDashboard();
    renderPlan();
    calculateWeeksTillRaceUI();
}

// Calculate weeks until race and generate countdown training plan
function calculateWeeksTillRaceUI() {
    const raceDateEl = document.getElementById('pRaceDate');
    const raceDateVal = raceDateEl ? raceDateEl.value : appData.profile.raceDate;
    const raceInfoBox = document.getElementById('raceCalculationBox');
    if (!raceInfoBox) return;

    if (!raceDateVal) {
        raceInfoBox.innerHTML = `
            <div style="font-size:12px; color:var(--text-dim);">
                Set your race date above to calculate exact training weeks and generate a tailored plan leading up to race day.
            </div>
        `;
        return;
    }

    const today = new Date();
    today.setHours(0,0,0,0);
    const race = new Date(raceDateVal);
    race.setHours(0,0,0,0);

    const diffTime = race.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays <= 0) {
        raceInfoBox.innerHTML = `
            <div style="font-size:12px; color:var(--warning);">
                Race date has passed or is today! Please select a future date.
            </div>
        `;
        return;
    }

    const weeksTillRace = Math.max(1, Math.ceil(diffDays / 7));
    raceInfoBox.innerHTML = `
        <div style="background:var(--bg-secondary); border:1px solid var(--accent); border-radius:var(--radius-sm); padding:14px; margin-top:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <span style="font-weight:700; color:var(--text-primary); font-size:14px;">🏁 Race Countdown</span>
                <span style="background:var(--accent-dim); color:var(--accent-bright); font-weight:700; padding:3px 8px; border-radius:6px; font-size:12px;">${weeksTillRace} Weeks (${diffDays} Days)</span>
            </div>
            <p style="font-size:12px; color:var(--text-secondary); margin-bottom:12px; line-height:1.5;">
                We can generate a customized <strong>${weeksTillRace}-week training periodization</strong> ending right at your race, with tailored Base, Build, Peak, and Taper phases!
            </p>
            <button class="btn btn-accent" style="width:100%; font-size:13px; padding:10px;" onclick="generatePlanTillRace(${weeksTillRace})">
                Generate ${weeksTillRace}-Week Plan Till Race
            </button>
        </div>
    `;
}

function generatePlanTillRace(weeks) {
    saveProfileForm();
    closeProfileModal();
    showPage('prompt');
    switchAITab('initial');
    generatePromptForWeeks(weeks);
    showToast(`AI prompt configured for ${weeks}-week countdown to race!`);
}

// Update Settings subsection UI (Login / Logout / Sync status / Legal)
function updateProfileSettingsUI() {
    const loggedInView = document.getElementById('settingsLoggedInView');
    const loggedOutView = document.getElementById('settingsLoggedOutView');
    const userEmailSpan = document.getElementById('settingsUserEmail');
    const localModeNotice = document.getElementById('settingsLocalNotice');

    if (currentUser) {
        if (loggedInView) loggedInView.style.display = 'block';
        if (loggedOutView) loggedOutView.style.display = 'none';
        if (userEmailSpan) userEmailSpan.textContent = currentUser.email;
        if (localModeNotice) localModeNotice.style.display = 'none';
    } else {
        if (loggedInView) loggedInView.style.display = 'none';
        if (loggedOutView) loggedOutView.style.display = 'block';
        if (localModeNotice) localModeNotice.style.display = 'flex';
    }
}

// Developer Access via Dedicated Modal (Fully functional on mobile & touch devices)
function promptDeveloperAccess() {
    closeModal('guideModal');
    closeProfileModal();
    const err = document.getElementById('devPasswordError');
    if (err) err.style.display = 'none';
    const input = document.getElementById('devPasswordInput');
    if (input) input.value = '';
    document.getElementById('devPasswordModal').classList.add('active');
    setTimeout(() => { if (input) input.focus(); }, 150);
}

function submitDeveloperPassword() {
    const input = document.getElementById('devPasswordInput');
    const pwd = input ? input.value.trim() : '';
    if (pwd === "Hello123") {
        closeModal('devPasswordModal');
        openDataModal();
        showToast("Developer access granted!");
    } else {
        const err = document.getElementById('devPasswordError');
        if (err) err.style.display = 'block';
    }
}

// Legal Policies & Disclaimers Modal
function openLegalModal() {
    document.getElementById('legalModal').classList.add('active');
}

// Motivational Quote Helper (Single quote per day fix)
function getTodayQuote(rawQuote) {
    if (!rawQuote || typeof rawQuote !== 'string') return "Consistency beats intensity. Keep pushing forward!";

    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const todayName = days[new Date().getDay()];

    if (rawQuote.includes('|')) {
        const quotes = rawQuote.split('|').map(q => q.trim());
        const match = quotes.find(q => q.toLowerCase().includes(todayName.toLowerCase()));
        if (match) {
            return match.replace(new RegExp(`^${todayName}:?\\s*`, 'i'), '').replace(/^"|"$/g, '');
        }
        const dayIdx = new Date().getDay();
        return (quotes[dayIdx] || quotes[0]).replace(/^[A-Za-z]+:\s*/, '').replace(/^"|"$/g, '');
    }

    const dayRegex = new RegExp(`(?:${todayName}|${todayName.slice(0,3)})\\s*:\\s*([^.|\\n]+(?=[\\s.]*(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sun|Mon|Tue|Wed|Thu|Fri|Sat)|$))`, 'i');
    const match = rawQuote.match(dayRegex);
    if (match && match[1]) {
        return match[1].trim().replace(/^"|"$/g, '');
    }

    const fallBackRegex = new RegExp(`${todayName}[^:]*:\\s*([^"|\\n]+)`, 'i');
    const fbMatch = rawQuote.match(fallBackRegex);
    if (fbMatch && fbMatch[1]) {
        return fbMatch[1].split('.')[0].trim().replace(/^"|"$/g, '');
    }

    return rawQuote.replace(/^"|"$/g, '').trim();
}

// Data Modal (Dev only)
function openDataModal() {
    const saved = getStorageItem('trit_data') || JSON.stringify(appData);
    const bytes = new Blob([saved]).size;
    const kb = (bytes / 1024).toFixed(2);
    
    document.getElementById('storageStatus').textContent = `Key: 'trit_data' (${kb} KB stored locally) | Mode: ${currentUser ? 'Cloud (Supabase)' : 'Local'}`;
    document.getElementById('storageInspectBox').textContent = JSON.stringify(appData, null, 2);
    document.getElementById('dataModal').classList.add('active');
}

function exportDataJSON() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appData, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `trit_data_backup_${new Date().toISOString().slice(0,10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    showToast('JSON backup exported!');
}

function copyDataJSON() {
    const jsonStr = JSON.stringify(appData, null, 2);
    navigator.clipboard.writeText(jsonStr).then(() => showToast('Data copied to clipboard!')).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = jsonStr;
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        showToast('Data copied to clipboard!');
    });
}

function importDataJSON() {
    const input = document.getElementById('importJsonInput').value.trim();
    if (!input) { showToast('Paste JSON backup first'); return; }
    try {
        const parsed = JSON.parse(input);
        appData = deepMerge(DEFAULT_DATA, parsed);
        saveData();
        showToast('Data restored successfully!');
        document.getElementById('importJsonInput').value = '';
        closeModal('dataModal');
        renderDashboard();
        if (document.getElementById('page-plan').classList.contains('active')) renderPlan();
    } catch(e) {
        showToast('Invalid JSON data format');
    }
}

function resetLocalStorage() {
    if (confirm('Are you sure you want to reset all local storage data? This cannot be undone.')) {
        if (confirm('Final Warning: All logged activities, plans, and events will be erased!')) {
            try { localStorage.removeItem('trit_data'); } catch(e) {}
            document.cookie = "trit_data=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
            appData = JSON.parse(JSON.stringify(DEFAULT_DATA));
            saveData();
            showToast('Local Storage reset complete!');
            closeModal('dataModal');
            renderDashboard();
            location.reload();
        }
    }
}

// Dashboard
function renderDashboard() {
    const p = appData.profile;
    document.getElementById('dashTargetSub').textContent = `Target: ${p.event} in ${p.targetTime}`;
    
    if (appData.plan && appData.plan.motivationalQuote) {
        document.getElementById('dashQuote').textContent = `"${getTodayQuote(appData.plan.motivationalQuote)}"`;
    } else {
        document.getElementById('dashQuote').textContent = `"Consistency beats intensity. Keep pushing forward!"`;
    }
    
    const runs = appData.runs;
    const runDist = runs.filter(r=>r.type==='Run').reduce((s, r) => s + (r.distance || 0), 0);
    const bikeDist = runs.filter(r=>r.type==='Bike').reduce((s, r) => s + (r.distance || 0), 0);
    const swimDist = runs.filter(r=>r.type==='Swim').reduce((s, r) => s + (r.distance || 0), 0);
    const totalHours = runs.reduce((s, r) => s + (r.duration || 0), 0) / 60;

    const completedCount = Object.keys(appData.completedWorkouts).length;
    const totalWorkouts = (appData.plan && appData.plan.weeks) ? appData.plan.weeks.reduce((s, w) => s + w.workouts.length, 0) : 0;
    
    const totalVol = runDist + bikeDist + swimDist;
    let runPct = totalVol ? (runDist/totalVol)*100 : 33.3;
    let bikePct = totalVol ? (bikeDist/totalVol)*100 : 33.3;
    let swimPct = totalVol ? (swimDist/totalVol)*100 : 33.3;

    document.getElementById('dashboardStats').innerHTML = `
        <div class="stat-card">
            <div class="stat-label">Run Vol</div>
            <div class="stat-value">${runDist.toFixed(1)} km</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Bike Vol</div>
            <div class="stat-value">${bikeDist.toFixed(0)} km</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Swim Vol</div>
            <div class="stat-value">${swimDist.toFixed(1)} km</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Total Time</div>
            <div class="stat-value">${totalHours.toFixed(1)} h</div>
        </div>
        <div class="stat-card volume-chart-card" style="grid-column: 1 / -1; padding-bottom: 16px;">
            <div class="stat-label">Volume Breakdown</div>
            <div style="display:flex; height:10px; border-radius:5px; overflow:hidden; margin-top:12px;">
                <div style="background:var(--accent); width:${runPct}%; transition: var(--transition);"></div>
                <div style="background:var(--green); width:${bikePct}%; transition: var(--transition);"></div>
                <div style="background:var(--blue); width:${swimPct}%; transition: var(--transition);"></div>
            </div>
            <div style="display:flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; font-size:11px; margin-top:8px; color:var(--text-dim); font-weight: 600;">
                <span style="color:var(--accent-bright)">Run ${Math.round(runPct)}%</span>
                <span style="color:var(--green)">Bike ${Math.round(bikePct)}%</span>
                <span style="color:var(--blue)">Swim ${Math.round(swimPct)}%</span>
            </div>
        </div>
    `;
    
    const pct = totalWorkouts ? Math.round((completedCount / totalWorkouts) * 100) : 0;
    document.getElementById('progressPct').textContent = pct + '%';
    document.getElementById('progressBar').style.width = pct + '%';
    document.getElementById('progressWeek').textContent = `Week ${p.currentWeek}`;
    document.getElementById('progressWorkouts').textContent = `${completedCount}/${totalWorkouts} done`;
}

// Calendar System
function renderCalendar() {
    const grid = document.getElementById('calendarGrid');
    if (!grid) return;
    grid.innerHTML = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => `<div class="calendar-day-header">${d}</div>`).join('');
    
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    document.getElementById('calendarMonthYear').textContent = `${monthNames[currentMonth]} ${currentYear}`;

    const firstDay = new Date(currentYear, currentMonth, 1).getDay();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const offset = firstDay === 0 ? 6 : firstDay - 1; 

    for (let i = 0; i < offset; i++) {
        grid.innerHTML += `<div class="calendar-day empty"></div>`;
    }

    const todayStr = new Date().toISOString().slice(0, 10);

    for (let i = 1; i <= daysInMonth; i++) {
        const dateObj = new Date(Date.UTC(currentYear, currentMonth, i));
        const dateStr = dateObj.toISOString().slice(0, 10);
        
        let classes = 'calendar-day';
        if (dateStr === todayStr) classes += ' today';
        if (dateStr === selectedDateStr) classes += ' selected';

        const customEvents = appData.customEvents.filter(e => e.date === dateStr);
        const planWorkouts = getPlanWorkoutsForDate(dateStr);
        
        let eventHTML = '';
        
        planWorkouts.forEach(w => {
            let typeColor = 'var(--accent)';
            if(w.type.toLowerCase().includes('bike')) typeColor = 'var(--green)';
            if(w.type.toLowerCase().includes('swim')) typeColor = 'var(--blue)';
            eventHTML += `<div class="mini-event" style="border-left-color: ${typeColor}">${w.type}</div>`;
        });

        customEvents.forEach(e => {
            eventHTML += `<div class="mini-event" style="border-left-color: ${e.color}">${e.title}</div>`;
        });

        grid.innerHTML += `
            <div class="${classes}" onclick="selectCalendarDate('${dateStr}')">
                <span class="calendar-day-num">${i}</span>
                <div class="day-events-container">${eventHTML}</div>
            </div>
        `;
    }
    updateSelectedEventsList();
}

function changeMonth(delta) {
    currentMonth += delta;
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    if (currentMonth < 0) { currentMonth = 11; currentYear--; }
    renderCalendar();
}

function selectCalendarDate(dateStr) {
    selectedDateStr = dateStr;
    renderCalendar();
}

function renderSavedCategories() {
    const list = document.getElementById('savedCategoriesList');
    if (!list) return;
    if(!appData.customCategories) appData.customCategories = [];
    list.innerHTML = appData.customCategories.map(c => 
        `<div class="cat-chip" onclick="applyCategory('${c.name}', '${c.color}')">
            <div class="cat-chip-color" style="background:${c.color}"></div>${c.name}
        </div>`
    ).join('');
}

let currentEventColor = '#ff6b35';

function selectWizardColor(hex) {
    currentEventColor = hex;
    const prev = document.getElementById('wizardColorPreview');
    if (prev) prev.style.background = hex;
    document.querySelectorAll('.color-preset-dot').forEach(dot => {
        const isMatch = dot.getAttribute('data-hex') === hex;
        dot.style.borderColor = isMatch ? 'var(--text-primary)' : 'transparent';
    });
}

function startCustomEventWizard(prefillDate = '') {
    currentEventColor = '#fc5200';
    const eventData = {
        title: '',
        category: '',
        color: currentEventColor,
        date: prefillDate || selectedDateStr || new Date().toISOString().slice(0, 10),
        time: '',
        place: '',
        details: ''
    };

    const colorPresets = [
        { name: 'Strava Orange', hex: '#fc5200' },
        { name: 'Electric Blue', hex: '#3b82f6' },
        { name: 'Emerald', hex: '#10b981' },
        { name: 'Purple', hex: '#8b5cf6' },
        { name: 'Rose', hex: '#f43f5e' },
        { name: 'Amber', hex: '#f59e0b' },
        { name: 'Cyan', hex: '#06b6d4' }
    ];

    openWizard('Add Custom Event', [
        {
            title: 'Step 1: Event & Category',
            canSkip: false,
            html: `
                <div class="form-group" style="margin-bottom:14px;">
                    <label>Event Title *</label>
                    <input type="text" id="wzEvTitle" placeholder="e.g. Physical Therapy, Race Registration, Rest Day..." autofocus>
                </div>
                <div class="form-group" style="margin-bottom:14px;">
                    <label>Category (Max 10)</label>
                    <input type="text" id="wzEvCat" placeholder="e.g. Health, Race, Work, Personal..." autocomplete="off">
                    ${appData.customCategories && appData.customCategories.length > 0 ? `
                        <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:8px;">
                            ${appData.customCategories.map(c => `
                                <button type="button" class="cat-chip" style="cursor:pointer; border:1px solid var(--border);" onclick="document.getElementById('wzEvCat').value='${c.name}'; selectWizardColor('${c.color}');">
                                    <div class="cat-chip-color" style="background:${c.color}"></div>${c.name}
                                </button>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
                <div class="form-group">
                    <label style="margin-bottom:8px; display:block;">Color</label>
                    <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                        ${colorPresets.map(c => `
                            <div class="color-preset-dot" 
                                 data-hex="${c.hex}" 
                                 style="width:30px; height:30px; border-radius:50%; background:${c.hex}; cursor:pointer; border:2px solid ${c.hex === '#fc5200' ? 'var(--text-primary)' : 'transparent'}; transition: transform 0.15s;" 
                                 onclick="selectWizardColor('${c.hex}')" title="${c.name}">
                            </div>
                        `).join('')}
                        <div style="position:relative; width:30px; height:30px; border-radius:50%; overflow:hidden; border:2px solid var(--border); display:flex; align-items:center; justify-content:center; background:var(--bg-secondary); cursor:pointer;" title="Custom Color">
                            <input type="color" id="wizardCustomColor" value="${currentEventColor}" style="position:absolute; top:-10px; left:-10px; width:60px; height:60px; opacity:0; cursor:pointer;" onchange="selectWizardColor(this.value)">
                            <div id="wizardColorPreview" style="width:100%; height:100%; background:${currentEventColor};"></div>
                        </div>
                    </div>
                </div>
            `,
            onSave: () => {
                const titleEl = document.getElementById('wzEvTitle');
                const catEl = document.getElementById('wzEvCat');
                const title = titleEl ? titleEl.value.trim() : '';
                if (!title) {
                    showToast('Please enter an event title');
                    if (titleEl) titleEl.focus();
                    return false;
                }
                eventData.title = title;
                eventData.category = (catEl && catEl.value.trim()) ? catEl.value.trim() : 'General';
                eventData.color = currentEventColor;
                return true;
            }
        },
        {
            title: 'Step 2: Date & Time',
            canSkip: true,
            html: `
                <div class="form-group" style="margin-bottom:14px;">
                    <label>Event Date</label>
                    <input type="date" id="wzEvDate" value="${eventData.date}">
                </div>
                <div class="form-group">
                    <label>Time (Optional)</label>
                    <input type="time" id="wzEvTime" value="${eventData.time}">
                </div>
            `,
            onSave: () => {
                const dateEl = document.getElementById('wzEvDate');
                const timeEl = document.getElementById('wzEvTime');
                if (dateEl && dateEl.value) eventData.date = dateEl.value;
                if (timeEl) eventData.time = timeEl.value;
                return true;
            }
        },
        {
            title: 'Step 3: Location & Details',
            canSkip: true,
            html: `
                <div class="form-group" style="margin-bottom:14px;">
                    <label>Location / Place (Optional)</label>
                    <input type="text" id="wzEvPlace" placeholder="e.g. Track, Office, Hospital, Virtual..." value="${eventData.place}">
                </div>
                <div class="form-group">
                    <label>Notes / Preparation (Optional)</label>
                    <textarea id="wzEvDetails" placeholder="Add preparation notes, reminders, or goals...">${eventData.details}</textarea>
                </div>
            `,
            onSave: () => {
                const placeEl = document.getElementById('wzEvPlace');
                const detailsEl = document.getElementById('wzEvDetails');
                if (placeEl) eventData.place = placeEl.value.trim();
                if (detailsEl) eventData.details = detailsEl.value.trim();
                return true;
            }
        }
    ], () => {
        if (!appData.customCategories) appData.customCategories = [];
        const catName = eventData.category || 'General';
        const existingCat = appData.customCategories.find(c => c.name.toLowerCase() === catName.toLowerCase());
        if (!existingCat) {
            if (appData.customCategories.length < 10) {
                appData.customCategories.push({ name: catName, color: eventData.color });
            }
        } else {
            existingCat.color = eventData.color;
        }

        appData.customEvents.push({
            id: Date.now(),
            title: eventData.title,
            category: catName,
            color: eventData.color,
            date: eventData.date,
            time: eventData.time,
            location: eventData.place,
            details: eventData.details
        });

        saveData();
        renderSavedCategories();
        selectCalendarDate(eventData.date);
        showToast("Event added to calendar!");
    });
}

function applyCategory(name, color) {
    if (name) {
        startCustomEventWizard();
        setTimeout(() => {
            const catEl = document.getElementById('wzEvCat');
            if (catEl) catEl.value = name;
            selectWizardColor(color);
        }, 100);
    }
}

function saveCustomEvent() {
    startCustomEventWizard();
}

function deleteCustomEvent(id) {
    appData.customEvents = appData.customEvents.filter(e => e.id !== id);
    saveData();
    renderCalendar();
    showToast("Event removed.");
}

function updateSelectedEventsList() {
    const list = document.getElementById('calendarSelectedEvents');
    if (!list) return;
    const custom = appData.customEvents.filter(e => e.date === selectedDateStr);
    const planWorkouts = getPlanWorkoutsForDate(selectedDateStr);

    if(custom.length === 0 && planWorkouts.length === 0) {
        list.innerHTML = `
            <div style="text-align:center; padding: 24px 16px; background:var(--bg-secondary); border-radius:var(--radius-sm); border:1px dashed var(--border);">
                <p style="color:var(--text-secondary); font-size:13px; margin-bottom:12px;">No activities scheduled for ${selectedDateStr}.</p>
                <button class="btn btn-outline" onclick="startCustomEventWizard('${selectedDateStr}')" style="font-size:12px; padding:8px 16px;">+ Add Event for this Date</button>
            </div>
        `;
        return;
    }

    let html = '';
    
    planWorkouts.forEach(w => {
        let typeColor = 'var(--accent)';
        if(w.type.toLowerCase().includes('bike')) typeColor = 'var(--green)';
        if(w.type.toLowerCase().includes('swim')) typeColor = 'var(--blue)';

        html += `
        <div class="event-card">
            <div style="position: absolute; top: 0; right: 0; width: 80px; height: 80px; background: radial-gradient(circle, ${typeColor}30 0%, transparent 70%); border-radius: 50%; transform: translate(30%, -30%); pointer-events: none; z-index: 1;"></div>
            <div class="event-card-header">
                <span>AI Plan • Week ${w.weekNum}</span>
                <span class="workout-type type-${w.type.toLowerCase()}">${w.type}</span>
            </div>
            <div class="event-card-title">${w.title}</div>
            <div class="event-card-meta">${w.distance || ''} ${w.duration ? '• '+w.duration : ''}</div>
            <button class="btn btn-outline" style="margin-top:10px; font-size:11px; padding:6px; position:relative; z-index:5;" onclick="showPage('plan'); selectWeek(${w.weekNum});">Go to Plan</button>
        </div>`;
    });

    custom.forEach(e => {
        html += `
        <div class="event-card">
            <div style="position: absolute; top: 0; right: 0; width: 80px; height: 80px; background: radial-gradient(circle, ${e.color}40 0%, transparent 70%); border-radius: 50%; transform: translate(30%, -30%); pointer-events: none; z-index: 1;"></div>
            <div class="event-card-header">
                <span class="cat-badge" style="color: ${e.color}">${e.category}</span>
                <span>${e.time || ''}</span>
            </div>
            <div class="event-card-title">${e.title}</div>
            <div class="event-card-meta">
                ${e.location ? '📍 '+e.location+'<br>' : ''}
                ${e.details ? '<span style="color:var(--text-secondary); margin-top:4px; display:block; white-space:pre-wrap;">' + e.details + '</span>' : ''}
            </div>
            <button class="delete-btn" style="align-self:flex-start; margin-top:10px;" onclick="deleteCustomEvent(${e.id})">Remove</button>
        </div>`;
    });

    html += `
        <div style="text-align:center; margin-top:16px;">
            <button class="btn btn-outline" onclick="startCustomEventWizard('${selectedDateStr}')" style="font-size:12px; padding:8px 16px;">+ Add Event for this Date</button>
        </div>
    `;

    list.innerHTML = html;
}

function getPlanWorkoutsForDate(dateStr) {
    if(!appData.plan || !appData.plan.weeks || !appData.profile.planStartDate) return [];
    const startDate = new Date(appData.profile.planStartDate);
    startDate.setUTCHours(0,0,0,0);
    
    const targetDate = new Date(dateStr);
    targetDate.setUTCHours(0,0,0,0);
    
    const diffTime = targetDate.getTime() - startDate.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    
    if(diffDays < 0) return []; 
    
    const weekIdx = Math.floor(diffDays / 7);
    const weekNum = weekIdx + 1;
    
    const daysArr = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    let dayIdx = (startDate.getDay() + diffDays - 1) % 7;
    if(dayIdx < 0) dayIdx += 7;
    const dayName = daysArr[dayIdx];

    const week = appData.plan.weeks.find(w => w.week === weekNum);
    if(!week) return [];
    
    return week.workouts.filter(w => w.day === dayName).map(w => ({...w, weekNum}));
}

// Collapsible AI Insight Handler
function toggleAiInsightCard(cardId) {
    const card = document.getElementById(cardId);
    if (card) {
        card.classList.toggle('collapsed');
        const btn = card.querySelector('.special-info-toggle-btn');
        if (btn) {
            btn.textContent = card.classList.contains('collapsed') ? 'Expand' : 'Collapse';
        }
    }
}

// Training Plan
function renderPlan() {
    const plan = appData.plan;
    const currentWeek = appData.profile.currentWeek;
    document.getElementById('planTargetSub').textContent = `Target: ${appData.profile.event} in ${appData.profile.targetTime}`;

    if (!plan || !plan.weeks || plan.weeks.length === 0) {
        document.getElementById('aiSpecialInfo').innerHTML = `
            <div class="special-info-card">
                <div class="special-info-header">
                    <div class="special-info-title">AI Insight</div>
                </div>
                <div class="special-info-text">No plan available. Go to the AI Coach tab to generate your initial plan.</div>
            </div>`;
        document.getElementById('weekSelector').innerHTML = '';
        document.getElementById('weekPhase').innerHTML = '';
        document.getElementById('weekWorkouts').innerHTML = '';
        return;
    }

    if (plan.specialInformation) {
        document.getElementById('aiSpecialInfo').innerHTML = `
            <div class="special-info-card collapsed" id="aiInsightPlanCard">
                <div class="special-info-header" onclick="toggleAiInsightCard('aiInsightPlanCard')">
                    <div class="special-info-title">AI Insight</div>
                    <div class="special-info-toggle-btn">Expand</div>
                </div>
                <div class="special-info-text">${plan.specialInformation}</div>
            </div>
        `;
    } else {
        document.getElementById('aiSpecialInfo').innerHTML = '';
    }

    document.getElementById('weekSelector').innerHTML = plan.weeks.map(w => `
        <button class="week-btn ${w.week === currentWeek ? 'active' : ''}" onclick="selectWeek(${w.week})">W${w.week}</button>
    `).join('');
    
    selectWeek(currentWeek);
}

function selectWeek(weekNum) {
    if(!appData.plan || !appData.plan.weeks) return;
    appData.profile.currentWeek = weekNum;
    saveData();

    document.querySelectorAll('.week-btn').forEach(b => {
        b.classList.remove('active');
        if (b.textContent === 'W' + weekNum) b.classList.add('active');
    });
    
    const week = appData.plan.weeks.find(w => w.week === weekNum);
    if (!week) return;
    
    document.getElementById('weekPhase').innerHTML = `
        <span class="phase-badge">${week.phase}</span>
        <h2 style="font-size:18px; margin-bottom:4px;">Week ${week.week}</h2>
        <p style="font-size:13px; color:var(--text-secondary); margin-bottom:20px;">${week.description}</p>
    `;
    
    document.getElementById('weekWorkouts').innerHTML = week.workouts.map((wo, i) => {
        const key = `w${weekNum}_${i}`;
        const done = appData.completedWorkouts[key];
        const descHtml = parseExerciseTerms(wo.desc);

        return `
        <div class="workout-card ${done ? 'completed' : ''}">
            <div class="workout-header">
                <span class="workout-day">${wo.day}</span>
                <span class="workout-type type-${wo.type.toLowerCase().replace(' ','')}">${wo.type}</span>
            </div>
            <div class="workout-title">${wo.title}</div>
            <div class="workout-desc">${descHtml}</div>
            <div class="workout-metrics">
                ${wo.distance ? `<div class="workout-metric">Distance: <span>${wo.distance}</span></div>` : ''}
                ${wo.pace ? `<div class="workout-metric">Pace: <span>${wo.pace}</span></div>` : ''}
                ${wo.duration ? `<div class="workout-metric">Duration: <span>${wo.duration}</span></div>` : ''}
            </div>
            <div class="workout-actions">
                <button class="btn ${done ? 'btn-accent' : ''}" style="flex:1; padding:8px; font-size:12px;" onclick="toggleWorkout('${key}')">
                    ${done ? 'Completed' : 'Mark Complete'}
                </button>
                <button class="btn btn-outline" style="flex:1; padding:8px; font-size:12px;" onclick="startLogWizard('${wo.type}')">Log</button>
            </div>
        </div>`;
    }).join('');
}

// History
function renderHistory() {
    const runs = appData.runs;
    const body = document.getElementById('historyBody');
    const emptyMsg = document.getElementById('noHistory');
    if (!body) return;

    if (!runs.length) {
        body.innerHTML = '';
        if (emptyMsg) emptyMsg.style.display = 'block';
        return;
    }
    if (emptyMsg) emptyMsg.style.display = 'none';
    body.innerHTML = [...runs].reverse().map(r => `
        <div class="history-card">
            <div class="history-main">
                <div style="display:flex; align-items:center; gap:8px;">
                    <span class="workout-type type-${r.type.toLowerCase()}">${r.type}</span>
                    <span class="history-date">${r.date}</span>
                </div>
                <div class="history-stats">
                    ${r.distance ? r.distance + ' units <span>|</span>' : ''} 
                    ${r.duration ? r.duration + ' min' : ''}
                </div>
            </div>
            <button class="delete-btn" onclick="deleteRun(${r.id})">Del</button>
        </div>`).join('');
}

function deleteRun(id) {
    if (!confirm('Delete this activity?')) return;
    appData.runs = appData.runs.filter(r => r.id !== id);
    saveData();
    renderHistory();
    renderDashboard();
    showToast("Activity deleted.");
}

// AI Coach Prompt Generation
function switchAITab(mode) {
    currentPromptMode = mode;
    const tabInit = document.getElementById('tabInitial');
    const tabUpd = document.getElementById('tabUpdate');
    const titleEl = document.getElementById('aiPromptTitle');
    const descEl = document.getElementById('aiPromptDesc');
    const wishesGroup = document.getElementById('athleteWishesGroup');
    const promptOut = document.getElementById('promptOutput');

    if (tabInit) tabInit.classList.toggle('active', mode === 'initial');
    if (tabUpd) tabUpd.classList.toggle('active', mode === 'update');

    if (mode === 'update') {
        if (titleEl) titleEl.textContent = 'Generate Weekly Update Prompt';
        if (descEl) descEl.textContent = 'Analyze your recent training logs, compare against your existing plan, and adapt upcoming weeks while keeping your schedule and routine as stable as possible.';
        if (wishesGroup) wishesGroup.style.display = 'block';
    } else {
        if (titleEl) titleEl.textContent = 'Generate Initial Prompt';
        if (descEl) descEl.textContent = 'Use your Profile baseline to generate a multi-week plan targeting your goals while avoiding injuries.';
        if (wishesGroup) wishesGroup.style.display = 'none';
    }

    if (promptOut) promptOut.textContent = 'Click Generate to begin...';
}

function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => fallbackClipboardCopy(text));
    } else {
        fallbackClipboardCopy(text);
    }
}

function fallbackClipboardCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
}

function generatePrompt() {
    generatePromptForWeeks(null);
}

// Format the initial/existing plan (past, current, and upcoming) for AI prompt injection
function formatPlanForPrompt(plan, currentWeekNum) {
    if (!plan || !plan.weeks || !plan.weeks.length) {
        return "[No prior multi-week plan found in app yet.\nIf you already had an initial training schedule, paste it here so the AI knows your existing routine;\notherwise, instruct the AI to design starting from Week " + currentWeekNum + " based on your profile availability.]";
    }

    const lines = [];

    // 1. Past weeks summary (what the user had done)
    const pastWeeks = plan.weeks.filter(w => w.week < currentWeekNum);
    if (pastWeeks.length > 0) {
        lines.push(`=== PAST WEEKS (COMPLETED / PREVIOUS) ===`);
        pastWeeks.forEach(w => {
            const completedCount = w.workouts.filter((_, idx) => appData.completedWorkouts[`w${w.week}_${idx}`]).length;
            lines.push(`• Week ${w.week} (${w.phase}): ${completedCount}/${w.workouts.length} scheduled workouts logged/completed. Focus: ${w.description || 'Base fitness'}`);
        });
        lines.push('');
    }

    // 2. Current Week (the initial plan they had for this active week)
    const currentW = plan.weeks.find(w => w.week === currentWeekNum);
    if (currentW) {
        lines.push(`=== CURRENT ACTIVE WEEK: WEEK ${currentW.week} (${currentW.phase}) ===`);
        lines.push(`Focus: ${currentW.description || 'Current training target'}`);
        lines.push(`Initial schedule for this week:`);
        currentW.workouts.forEach((wo, idx) => {
            const isDone = !!appData.completedWorkouts[`w${currentW.week}_${idx}`];
            const statusTag = isDone ? "[COMPLETED]" : "[PENDING / UPCOMING]";
            const metrics = [
                wo.distance ? `Dist: ${wo.distance}` : '',
                wo.duration ? `Duration: ${wo.duration}` : '',
                wo.pace ? `Pace: ${wo.pace}` : ''
            ].filter(Boolean).join(', ');
            lines.push(`  • ${wo.day} (${wo.type}) ${statusTag}: "${wo.title}"${metrics ? ` [${metrics}]` : ''}${wo.desc ? ` — ${wo.desc}` : ''}`);
        });
        lines.push('');
    }

    // 3. Upcoming Future Weeks (the initial plan the user will have)
    const upcomingWeeks = plan.weeks.filter(w => w.week > currentWeekNum);
    if (upcomingWeeks.length > 0) {
        lines.push(`=== UPCOMING WEEKS SCHEDULE (INITIAL PLAN THE USER WILL HAVE) ===`);
        upcomingWeeks.forEach(w => {
            lines.push(`• Week ${w.week} (${w.phase}) — ${w.description || 'Target progression'}:`);
            w.workouts.forEach(wo => {
                const metrics = [
                    wo.distance ? `Dist: ${wo.distance}` : '',
                    wo.duration ? `Duration: ${wo.duration}` : '',
                    wo.pace ? `Pace: ${wo.pace}` : ''
                ].filter(Boolean).join(', ');
                lines.push(`    - ${wo.day} (${wo.type}): "${wo.title}"${metrics ? ` [${metrics}]` : ''}${wo.desc ? ` — ${wo.desc}` : ''}`);
            });
        });
    }

    return lines.join('\n');
}

function generatePromptForWeeks(targetWeeks = null) {
    const p = appData.profile;
    const a = p.availability;
    const availStr = `Mon: ${a.mon}m, Tue: ${a.tue}m, Wed: ${a.wed}m, Thu: ${a.thu}m, Fri: ${a.fri}m, Sat: ${a.sat}m, Sun: ${a.sun}m. (0 means NO training possible).`;
    
    let prompt = "";

    if (currentPromptMode === 'initial') {
        const weeksText = targetWeeks 
            ? `Design an exact ${targetWeeks}-week plan leading directly up to race day on ${p.raceDate || 'the final week'}. Include structured Base, Build, Peak, and Taper phases.`
            : `Create a progressive 5-week block (or tailored to race date).`;

        prompt = `You are an elite endurance and multi-sport coach. Create an Initial Training Plan.

[ATHLETE PROFILE]
• Age: ${p.age}
• Target: ${p.event} (Goal Time: ${p.targetTime})
• Race Date: ${p.raceDate || "Not specified"}
• Baseline: Swim: ${p.stats.swim} | Bike: ${p.stats.bike} | Run: ${p.stats.run}
• Gear: Bike: ${p.gear.bike} | Shoes: ${p.gear.shoes} | Watch: ${p.gear.watch}
• Current Limitations: ${p.limitations || "None"}
• Availability: ${availStr}

[TASKS]
1. Assess goal realism and provide direct encouragement or modifications in "specialInformation".
2. ${weeksText}
   - Tailor specifically to their discipline goals. Multiple sessions in a single day are allowed.
3. Provide daily motivational quotes formatted with explicit day dividers using pipes, e.g. "Monday: ... | Tuesday: ... | Wednesday: ..." in "motivationalQuote".
4. If using specific terminology in descriptions, wrap it in pipes (e.g., |Brick Workout|) and add the definition and 'how to execute' to the "dictionary" array.
5. Output strict JSON only.

{
  "motivationalQuote": "Monday: Stay focused. | Tuesday: Small steps matter. | Wednesday: Build endurance.",
  "specialInformation": "Your feedback...",
  "dictionary": [
    {"term": "Brick Workout", "definition": "A workout combining two disciplines consecutively.", "howTo": "Immediately transition from bike to run."}
  ],
  "weeks": [
    {
      "week": 1,
      "phase": "Base",
      "description": "...",
      "workouts": [
        {
          "day": "Tuesday",
          "type": "Swim|Bike|Run|Brick|Rest",
          "title": "...",
          "distance": "...",
          "duration": "...",
          "pace": "...",
          "desc": "Description with |terms|..."
        }
      ]
    }
  ]
}`;
    } else {
        const runs = appData.runs.slice(-10);
        const runLog = runs.map(r => `${r.date} [${r.type}]: ${r.distance}km, ${r.duration}m. Notes: ${r.notes||'none'}`).join('\n');
        
        const wishesEl = document.getElementById('athleteWishesInput');
        const userWishes = wishesEl ? wishesEl.value.trim() : '';
        const wishesSection = userWishes
            ? userWishes
            : `[ATHLETE'S WISHES & SPECIAL REQUESTS (CUSTOMIZE OR LEAVE AS-IS):
 • Schedule adjustments: (e.g., "Need Saturday morning free, shift long ride to Sunday", "Traveling for 2 days, need hotel-friendly or treadmill sessions")
 • Workout preferences: (e.g., "Keep Tuesday bike workout unchanged", "Want an extra recovery session", "Feeling ready for longer swim intervals")
 • Health & fatigue notes: (e.g., "Mild left knee tightness after Thursday run, reduce impact", "Feeling fresh and fully recovered")
 • Default: "None - please keep training schedule as identical to initial plan as possible."]`;

        const planSection = formatPlanForPrompt(appData.plan, p.currentWeek);

        prompt = `You are an elite endurance and multi-sport coach updating the athlete's training plan.

[ATHLETE PROFILE & TARGETS]
• Target Event: ${p.event} (Goal Time: ${p.targetTime})
• Race Date: ${p.raceDate || "Not specified"}
• Current Active Week: Week ${p.currentWeek}
• Known Limitations / Health: ${p.limitations || "None"}
• Weekly Availability: ${availStr}

[ATHLETE'S WISHES & SPECIAL REQUESTS FOR THIS WEEK]
${wishesSection}

[RECENT LOGGED ACTIVITIES (LAST 10)]
${runLog || "No recent activity logs recorded yet."}

[INITIAL & SCHEDULED TRAINING PLAN (WHAT THE USER HAD AND WILL HAVE)]
${planSection}

[CORE COACHING DIRECTIVES: SCHEDULE STABILITY & MINIMAL INTERVENTION]
1. HIGH SCHEDULE FIDELITY (PRIMARY DIRECTIVE):
   • You MUST try to keep the weekly training schedule, workout distribution, and discipline days as SIMILAR and STABLE as possible compared to the athlete's initial plan.
   • DO NOT overhaul, rewrite, or unnecessarily reshuffle workouts across days. Athletes rely on consistent routines (e.g. keeping Tuesday as Bike, Saturday as Long Ride, etc.).
2. ONLY CHANGE IF STRICTLY NECESSARY:
   • Modify, substitute, or recalibrate workouts ONLY when genuinely justified by:
     (a) The athlete's specific wishes, travel constraints, or preferences listed above.
     (b) Reported injuries, excessive fatigue, or persistent soreness in recent logs.
     (c) Missed critical workouts that require safe, progressive adjustment without sudden volume spikes.
   • If a scheduled workout was executed well and no conflicts exist, RETAIN IT IN THE PLAN with its original day, discipline, title, and structure (applying only standard progressive calibration to pacing/distance if appropriate).
3. ADAPTATION SCOPE:
   • Adjust any remaining pending workouts for Week ${p.currentWeek} and upcoming Week ${p.currentWeek + 1} (and any subsequent weeks as needed).
   • In "specialInformation", provide a transparent coaching overview detailing:
     - Exactly what was KEPT UNCHANGED to preserve the athlete's routine and momentum.
     - What was CHANGED (if anything) and the specific reason based on athlete wishes or recent logs.
4. MOTIVATION & DICTIONARY:
   • Provide daily motivational quotes formatted with pipes: "Monday: ... | Tuesday: ... | Wednesday: ..." in "motivationalQuote".
   • If any new specialized training terms are introduced, wrap them in pipes (e.g. |Cadence Drills|) and define them in the "dictionary" array.
5. STRICT JSON OUTPUT:
   Output valid, parseable JSON only matching the schema:

{
  "motivationalQuote": "Monday: Stay steady. | Tuesday: Trust the rhythm. | Wednesday: Smooth cadence.",
  "specialInformation": "Coaching overview: Kept your core schedule intact to maintain momentum. Adjusted...",
  "dictionary": [],
  "weeks": [
    {
      "week": ${p.currentWeek},
      "phase": "...",
      "description": "...",
      "workouts": [
        {
          "day": "Tuesday",
          "type": "Swim|Bike|Run|Brick|Rest",
          "title": "...",
          "distance": "...",
          "duration": "...",
          "pace": "...",
          "desc": "..."
        }
      ]
    }
  ]
}`;
    }

    document.getElementById('promptOutput').textContent = prompt;
    copyTextToClipboard(prompt);
    showToast('Prompt generated & copied to clipboard!');
}

function copyPrompt() {
    const text = document.getElementById('promptOutput').textContent;
    copyTextToClipboard(text);
    showToast('Copied to clipboard!');
}

function applyAIPlan() {
    const input = document.getElementById('aiPlanInput').value.trim();
    if (!input) { showToast('Paste JSON first'); return; }

    try {
        let jsonStr = input;
        const match = input.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match) jsonStr = match[1];
        else { const match2 = input.match(/\{[\s\S]*\}/); if (match2) jsonStr = match2[0]; }
        
        const newPlan = JSON.parse(jsonStr);
        if (!newPlan.weeks) throw new Error('Invalid structure: missing weeks array');

        if (newPlan.dictionary) {
            newPlan.dictionary.forEach(d => {
                appData.exerciseDB[d.term.toLowerCase()] = { definition: d.definition, howTo: d.howTo };
            });
        }

        const overwriteEl = document.getElementById('overwritePlanCheck');
        const overwrite = overwriteEl ? overwriteEl.checked : true;

        if (overwrite || !appData.plan) {
            appData.plan = newPlan;
            appData.completedWorkouts = {}; 
            appData.profile.currentWeek = newPlan.weeks[0]?.week || 1;
        } else {
            const existingWeeks = appData.plan.weeks.filter(w => !newPlan.weeks.find(nw => nw.week === w.week));
            appData.plan = {
                motivationalQuote: newPlan.motivationalQuote || appData.plan.motivationalQuote,
                specialInformation: newPlan.specialInformation || appData.plan.specialInformation,
                weeks: [...existingWeeks, ...newPlan.weeks].sort((a,b) => a.week - b.week)
            };
        }
        
        saveData();
        showToast('Plan applied!');
        document.getElementById('aiPlanInput').value = '';
        showPage('plan');
    } catch (e) { showToast('Error: ' + e.message); }
}

// Utils & Wizards
function parseExerciseTerms(text) {
    if (!text) return '';
    return text.replace(/\|([^|]+)\|/g, (match, term) => `<span class="exercise-term" onclick="showDictEntry('${term}')">${term}</span>`);
}

function showDictEntry(term) {
    const entry = appData.exerciseDB[term.toLowerCase()];
    document.getElementById('dictTitle').textContent = term;
    if(entry) {
        document.getElementById('dictDefinition').textContent = entry.definition;
        document.getElementById('dictHowTo').textContent = entry.howTo;
    } else {
        document.getElementById('dictDefinition').textContent = "Term definition pending AI update.";
        document.getElementById('dictHowTo').textContent = "No execution instructions found.";
    }
    document.getElementById('dictModal').classList.add('active');
}

function toggleWorkout(key) {
    if (appData.completedWorkouts[key]) delete appData.completedWorkouts[key];
    else appData.completedWorkouts[key] = new Date().toISOString();
    saveData();
    renderPlan();
    renderDashboard();
}

function showToast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3200);
}

function openGuide() { document.getElementById('guideModal').classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

// Wizard System for Activity Logging & Custom Events
let wizardSteps = [];
let currentWizardStep = 0;
let wizardOnComplete = null;

function openWizard(title, steps, onComplete) {
    document.getElementById('wizardTitle').textContent = title;
    wizardSteps = steps;
    currentWizardStep = 0;
    wizardOnComplete = onComplete;
    document.getElementById('wizardModal').classList.add('active');
    renderWizardStep();
}

function closeWizard() { document.getElementById('wizardModal').classList.remove('active'); }

function renderWizardStep() {
    const step = wizardSteps[currentWizardStep];
    document.getElementById('wizardProgress').innerHTML = wizardSteps.map((_, i) => `<div class="wizard-dot ${i <= currentWizardStep ? 'active' : ''}"></div>`).join('');
    document.getElementById('wizardBody').innerHTML = `
        <div class="wizard-step active">
            <h3 style="margin-bottom:16px; font-size:16px;">${step.title}</h3>
            ${step.html}
        </div>
    `;
    
    document.getElementById('wizardBtnPrev').style.display = currentWizardStep > 0 ? 'block' : 'none';
    document.getElementById('wizardBtnSkip').style.display = step.canSkip ? 'block' : 'none';
    document.getElementById('wizardBtnNext').textContent = currentWizardStep === wizardSteps.length - 1 ? 'Finish' : 'Next';

    if(step.onRender) step.onRender();
}

function wizardNext() {
    const step = wizardSteps[currentWizardStep];
    if(step.onSave) {
        const valid = step.onSave();
        if(valid === false) return; 
    }
    
    if (currentWizardStep < wizardSteps.length - 1) {
        currentWizardStep++;
        renderWizardStep();
    } else {
        if(wizardOnComplete) wizardOnComplete();
        closeWizard();
    }
}

function wizardPrev() {
    if (currentWizardStep > 0) {
        currentWizardStep--;
        renderWizardStep();
    }
}

function wizardSkip() {
    const step = wizardSteps[currentWizardStep];
    if (step && step.onSkip) step.onSkip();
    if (currentWizardStep < wizardSteps.length - 1) {
        currentWizardStep++;
        renderWizardStep();
    } else {
        if(wizardOnComplete) wizardOnComplete();
        closeWizard();
    }
}

function startLogWizard(prefillType = '', prefillDate = '') {
    let logData = { date: prefillDate || new Date().toISOString().slice(0, 10), type: prefillType || 'Run' };
    openWizard('Log Activity', [
        {
            title: 'Basics', canSkip: false,
            html: `
                <div class="form-group"><label>Date</label><input type="date" id="lDate" value="${logData.date}"></div>
                <div class="form-group"><label>Type</label>
                    <select id="lType">
                        <option value="Run" ${logData.type.toLowerCase().includes('run')?'selected':''}>Run</option>
                        <option value="Bike" ${logData.type.toLowerCase().includes('bike')?'selected':''}>Bike</option>
                        <option value="Swim" ${logData.type.toLowerCase().includes('swim')?'selected':''}>Swim</option>
                        <option value="Brick" ${logData.type.toLowerCase().includes('brick')?'selected':''}>Brick</option>
                        <option value="Strength">Strength / Other</option>
                    </select>
                </div>
            `,
            onSave: () => {
                logData.date = document.getElementById('lDate').value;
                logData.type = document.getElementById('lType').value;
                if(!logData.date) { showToast('Date required'); return false; }
            }
        },
        {
            title: 'Metrics & Feel', canSkip: true,
            html: `
                <div style="display:flex; gap:10px;">
                    <div class="form-group" style="flex:1;"><label>Dist (km)</label><input type="number" step="0.01" id="lDist"></div>
                    <div class="form-group" style="flex:1;"><label>Dur (min)</label><input type="number" id="lDur"></div>
                </div>
                <div class="form-group" style="margin-top:12px;"><label>Perceived Effort (1-10)</label><input type="number" min="1" max="10" id="lRpe"></div>
                <div class="form-group"><label>Notes (Fatigue, Adjustments)</label><textarea id="lNotes"></textarea></div>
            `,
            onSave: () => {
                logData.distance = parseFloat(document.getElementById('lDist').value) || 0;
                logData.duration = parseFloat(document.getElementById('lDur').value) || 0;
                logData.rpe = parseInt(document.getElementById('lRpe').value) || 0;
                logData.notes = document.getElementById('lNotes').value;
            }
        }
    ], () => {
        logData.id = Date.now();
        appData.runs.push(logData);
        appData.runs.sort((a, b) => new Date(a.date) - new Date(b.date));
        saveData();
        showToast('Activity Logged!');
        renderDashboard();
        if(document.getElementById('page-history').classList.contains('active')) renderHistory();
    });
}

// Modal overlay close clicks
document.querySelectorAll('.modal-overlay').forEach(el => { el.addEventListener('click', (e) => { if (e.target === el) el.classList.remove('active'); }); });
document.querySelectorAll('.wizard-overlay').forEach(el => { el.addEventListener('click', (e) => { if (e.target === el) closeWizard(); }); });

// Export functions to window for inline onclick handlers
window.showPage = showPage;
window.openProfileModal = openProfileModal;
window.closeProfileModal = closeProfileModal;
window.switchProfileSubtab = switchProfileSubtab;
window.setAthleteStep = setAthleteStep;
window.athleteWizardNext = athleteWizardNext;
window.athleteWizardPrev = athleteWizardPrev;
window.athleteWizardSkip = athleteWizardSkip;
window.saveProfileForm = saveProfileForm;
window.calculateWeeksTillRaceUI = calculateWeeksTillRaceUI;
window.generatePlanTillRace = generatePlanTillRace;
window.authSignUp = authSignUp;
window.authSignIn = authSignIn;
window.authSignOut = authSignOut;
window.deleteCloudAccountData = deleteCloudAccountData;
window.promptDeveloperAccess = promptDeveloperAccess;
window.submitDeveloperPassword = submitDeveloperPassword;
window.openLegalModal = openLegalModal;
window.startLogWizard = startLogWizard;
window.startCustomEventWizard = startCustomEventWizard;
window.selectWizardColor = selectWizardColor;
window.toggleAiInsightCard = toggleAiInsightCard;
window.selectWeek = selectWeek;
window.toggleWorkout = toggleWorkout;
window.showDictEntry = showDictEntry;
window.deleteRun = deleteRun;
window.changeMonth = changeMonth;
window.selectCalendarDate = selectCalendarDate;
window.applyCategory = applyCategory;
window.saveCustomEvent = saveCustomEvent;
window.deleteCustomEvent = deleteCustomEvent;
window.switchAITab = switchAITab;
window.generatePrompt = generatePrompt;
window.copyPrompt = copyPrompt;
window.applyAIPlan = applyAIPlan;
window.openGuide = openGuide;
window.closeModal = closeModal;
window.openWizard = openWizard;
window.closeWizard = closeWizard;
window.wizardNext = wizardNext;
window.wizardPrev = wizardPrev;
window.wizardSkip = wizardSkip;
window.openDataModal = openDataModal;
window.exportDataJSON = exportDataJSON;
window.copyDataJSON = copyDataJSON;
window.importDataJSON = importDataJSON;
window.resetLocalStorage = resetLocalStorage;
window.syncToSupabase = syncToSupabase;
window.manualCloudSync = manualCloudSync;
