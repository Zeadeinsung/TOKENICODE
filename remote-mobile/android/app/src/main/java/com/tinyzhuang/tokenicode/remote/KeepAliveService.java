package com.tinyzhuang.tokenicode.remote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Holds its own WebSocket to the desktop TOKENICODE host and posts a system
 * notification when a task finishes or needs the user.
 *
 * The WebView cannot do this job: Capacitor's bridge keeps JS running while the
 * app is merely backgrounded, but swiping the app out of the recents list
 * destroys the Activity and with it the WebView. A foreground service survives
 * that, so the connection has to live here instead of in JS.
 *
 * Wire protocol is the same one `src/protocol.ts` speaks, minus RPC: the server
 * broadcasts `{ "ev": "claude:stream:<stdinId>", "data": <stream json> }` to
 * every connected client, so this is simply a second, headless client.
 */
public class KeepAliveService extends Service {
    private static final String TAG = "TKKeepAlive";

    public static final String ACTION_START = "com.tinyzhuang.tokenicode.remote.KEEPALIVE_START";
    public static final String EXTRA_BASE = "base";
    public static final String EXTRA_TOKEN = "token";

    private static final String PREFS = "tokenicode_keepalive";
    private static final String CH_KEEPALIVE = "tk_keepalive";
    private static final String CH_TASKS = "tk_tasks";
    private static final int ID_KEEPALIVE = 41;
    private static final int ID_TASK_BASE = 1000;

    /** Wake lock budget, renewed on every received frame and on every connect.
     *  Long enough to cover a busy turn, short enough that an abandoned service
     *  stops pinning the CPU. */
    private static final long WAKE_LOCK_MS = 30 * 60 * 1000L;

    /** Whatever the visible session is, set by the JS layer. Used to stay quiet
     *  when the user is already looking at the session that just finished. */
    private static volatile String foregroundSession = null;
    private static volatile boolean appForeground = false;

    private static class Session {
        String cwd;
        String lastPrompt;
        /** Claude CLI session UUID, learned from any event carrying
         *  `session_id`. Used to deep-link a tapped notification. */
        String cliSessionId;
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable reconnect = new Runnable() {
        @Override
        public void run() {
            if (!stopping) connect();
        }
    };
    private final Map<String, Session> sessions = new HashMap<>();

    private OkHttpClient client;
    private WebSocket socket;
    private PowerManager.WakeLock wakeLock;
    private String base;
    private String token;
    private int retries = 0;
    private int nextNotificationId = ID_TASK_BASE;
    private boolean stopping = false;

    /** Called from the plugin as the visible session / app state changes. */
    public static void setContext(String stdinId, boolean foreground) {
        foregroundSession = stdinId;
        appForeground = foreground;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        client = new OkHttpClient.Builder()
                // Keeps NAT mappings and dead sockets honest without a stall timer.
                .pingInterval(30, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .build();
        createChannels();

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tokenicode:keepalive");
            wakeLock.setReferenceCounted(false);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        stopping = false;

        if (intent != null && intent.getStringExtra(EXTRA_BASE) != null) {
            String nextBase = intent.getStringExtra(EXTRA_BASE);
            String nextToken = intent.getStringExtra(EXTRA_TOKEN);
            if (!nextBase.equals(base) || !nextToken.equals(token)) {
                closeSocket();
                retries = 0;
            }
            base = nextBase;
            token = nextToken;
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString(EXTRA_BASE, base)
                    .putString(EXTRA_TOKEN, token)
                    .apply();
        } else {
            // Restarted by the system with a null intent.
            SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
            base = p.getString(EXTRA_BASE, null);
            token = p.getString(EXTRA_TOKEN, null);
        }

        startForegroundCompat();
        refreshWakeLock();
        if (socket == null) connect();
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** Swiping the app away must not take the connection down. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // no-op on purpose
    }

    @Override
    public void onDestroy() {
        stopping = true;
        handler.removeCallbacks(reconnect);
        closeSocket();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    // --- connection ---------------------------------------------------------

    private void connect() {
        if (base == null || token == null) {
            Log.w(TAG, "no host configured; not connecting");
            return;
        }
        String url = wsUrl();
        if (url == null) {
            Log.w(TAG, "bad base url: " + base);
            scheduleReconnect();
            return;
        }

        Request request = new Request.Builder().url(url).build();
        socket = client.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket ws, Response response) {
                retries = 0;
                refreshWakeLock();
                Log.i(TAG, "connected");
            }

            @Override
            public void onMessage(WebSocket ws, String text) {
                refreshWakeLock();
                handleFrame(text);
            }

            @Override
            public void onClosing(WebSocket ws, int code, String reason) {
                ws.close(1000, null);
            }

            @Override
            public void onClosed(WebSocket ws, int code, String reason) {
                scheduleReconnect();
            }

            @Override
            public void onFailure(WebSocket ws, Throwable t, @Nullable Response response) {
                Log.w(TAG, "socket failed: " + t);
                scheduleReconnect();
            }
        });
    }

    private String wsUrl() {
        try {
            HttpUrl parsed = HttpUrl.get(base);
            String scheme = "https".equals(parsed.scheme()) ? "wss" : "ws";
            return parsed.newBuilder()
                    .scheme(scheme)
                    .addPathSegment("ws")
                    .addQueryParameter("token", token)
                    .build()
                    .toString();
        } catch (Exception e) {
            return null;
        }
    }

    private void scheduleReconnect() {
        socket = null;
        if (stopping) return;
        // Same backoff curve as the web client: 800ms doubling, capped at 8s.
        long delay = Math.min(800L * (1L << Math.min(retries, 4)), 8000L);
        retries++;
        handler.removeCallbacks(reconnect);
        handler.postDelayed(reconnect, delay);
    }

    private void closeSocket() {
        WebSocket ws = socket;
        socket = null;
        if (ws != null) {
            try {
                ws.cancel();
            } catch (Exception ignored) {
                // already gone
            }
        }
    }

    private void refreshWakeLock() {
        if (wakeLock == null) return;
        wakeLock.acquire(WAKE_LOCK_MS);
    }

    // --- event handling -----------------------------------------------------

    private void handleFrame(String text) {
        try {
            JSONObject root = new JSONObject(text);
            String ev = root.optString("ev", "");
            if (!ev.startsWith("claude:stream:")) return;

            String stdinId = ev.substring("claude:stream:".length());
            JSONObject data = root.optJSONObject("data");
            if (data == null) return;

            Session session = sessions.get(stdinId);
            if (session == null) {
                session = new Session();
                sessions.put(stdinId, session);
            }

            // Sticky across the session's lifetime: `system/init` carries it
            // first, and a notification posted later can then name the session.
            String cliId = data.optString("session_id", "");
            if (!cliId.isEmpty()) session.cliSessionId = cliId;

            String type = data.optString("type", "");
            if ("system".equals(type)) {
                if ("init".equals(data.optString("subtype")) && !data.optString("cwd", "").isEmpty()) {
                    session.cwd = data.optString("cwd");
                }
                return;
            }
            if ("user".equals(type)) {
                String prompt = firstUserText(data);
                if (prompt != null) session.lastPrompt = prompt;
                return;
            }
            // Completion is deliberately silent: a batch of parallel tasks would
            // otherwise buzz the phone once each. Only a question that blocks the
            // CLI interrupts the user.
            if ("tokenicode_permission_request".equals(type)) {
                notifyInput(session, stdinId);
                return;
            }
            if ("process_exit".equals(type)) {
                sessions.remove(stdinId);
            }
        } catch (Exception e) {
            Log.w(TAG, "unparseable frame", e);
        }
    }

    /** Mirrors the web client's replay handling: the last text block of a
     *  replayed user message is the prompt the user typed. */
    private String firstUserText(JSONObject data) {
        JSONObject message = data.optJSONObject("message");
        if (message == null) return null;
        Object content = message.opt("content");
        if (content instanceof String) {
            String s = ((String) content).trim();
            return s.isEmpty() ? null : s;
        }
        if (!(content instanceof JSONArray)) return null;
        JSONArray blocks = (JSONArray) content;
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < blocks.length(); i++) {
            JSONObject block = blocks.optJSONObject(i);
            if (block == null) continue;
            if (!"text".equals(block.optString("type"))) continue;
            String t = block.optString("text", "");
            if (!t.isEmpty()) out.append(t);
        }
        String joined = out.toString().trim();
        return joined.isEmpty() ? null : joined;
    }

    private boolean suppress(String stdinId) {
        return appForeground && stdinId.equals(foregroundSession);
    }

    private void notifyInput(Session session, String stdinId) {
        if (suppress(stdinId)) return;
        post(getString(R.string.notif_needs_input) + projectSuffix(session), session.lastPrompt,
                sessionKey(session, stdinId));
    }

    /** What the tap should open. The CLI id is stable for the whole session and
     *  still resolves after the process has exited; the stdin id is the fallback
     *  for a service that connected mid-session and never saw `init`. */
    private static String sessionKey(Session session, String stdinId) {
        return session.cliSessionId != null && !session.cliSessionId.isEmpty()
                ? session.cliSessionId
                : stdinId;
    }

    private String projectSuffix(Session session) {
        String name = projectName(session.cwd);
        return name.isEmpty() ? "" : " · " + name;
    }

    private static String projectName(String cwd) {
        if (cwd == null || cwd.isEmpty()) return "";
        String trimmed = cwd.replaceAll("/+$", "");
        int slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
        return slash >= 0 ? trimmed.substring(slash + 1) : trimmed;
    }

    // --- notifications ------------------------------------------------------

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        NotificationChannel keepalive = new NotificationChannel(
                CH_KEEPALIVE,
                getString(R.string.keepalive_channel),
                NotificationManager.IMPORTANCE_MIN);
        keepalive.setDescription(getString(R.string.keepalive_channel_desc));
        keepalive.setShowBadge(false);
        nm.createNotificationChannel(keepalive);

        NotificationChannel tasks = new NotificationChannel(
                CH_TASKS,
                getString(R.string.tasks_channel),
                NotificationManager.IMPORTANCE_HIGH);
        tasks.setDescription(getString(R.string.tasks_channel_desc));
        nm.createNotificationChannel(tasks);
    }

    private void startForegroundCompat() {
        Notification notification = new NotificationCompat.Builder(this, CH_KEEPALIVE)
                .setSmallIcon(R.drawable.ic_stat_tokenicode)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(getString(R.string.keepalive_running))
                .setContentIntent(openAppIntent(null))
                .setOngoing(true)
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .build();

        // API 34+ rejects startForeground without an explicit, manifest-declared
        // type once targetSdk is 34 or higher.
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
                ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                : 0;
        ServiceCompat.startForeground(this, ID_KEEPALIVE, notification, type);
    }

    private void post(String title, String body, String sessionKey) {
        String text = body == null ? "" : body;
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CH_TASKS)
                .setSmallIcon(R.drawable.ic_stat_tokenicode)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(openAppIntent(sessionKey))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH);

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        // A fresh id per notification so two tasks finishing back to back both
        // stay in the shade instead of replacing each other.
        nm.notify(nextNotificationId++, builder.build());
        if (nextNotificationId > ID_TASK_BASE + 500) nextNotificationId = ID_TASK_BASE;
    }

    /** Tap target for a notification. When a session is named, the intent also
     *  carries it so the app can jump straight to that conversation. */
    private PendingIntent openAppIntent(String sessionKey) {
        Intent intent = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        int requestCode = 0;
        if (sessionKey != null && !sessionKey.isEmpty()) {
            intent.putExtra(MainActivity.EXTRA_OPEN_SESSION, sessionKey);
            // Per-session data URI and request code. Without them every
            // PendingIntent compares equal and FLAG_UPDATE_CURRENT leaves only
            // the last session's extra, so all taps would open one session.
            intent.setData(Uri.parse("tokenicode://session/" + sessionKey));
            requestCode = sessionKey.hashCode();
        }
        return PendingIntent.getActivity(
                this,
                requestCode,
                intent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}
