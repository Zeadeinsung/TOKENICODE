package com.tinyzhuang.tokenicode.remote;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * JS surface for the keep-alive service.
 *
 * Registered by hand in `MainActivity.onCreate` rather than through
 * `capacitor.plugins.json`, which `npx cap sync` rewrites.
 */
@CapacitorPlugin(
        name = "KeepAlive",
        permissions = {
                @Permission(
                        alias = "notifications",
                        strings = { Manifest.permission.POST_NOTIFICATIONS })
        })
public class KeepAlivePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String base = call.getString("base");
        String token = call.getString("token");
        if (base == null || base.isEmpty() || token == null || token.isEmpty()) {
            call.reject("base and token are required");
            return;
        }

        if (needsNotificationPermission()) {
            requestPermissionForAlias("notifications", call, "notificationsPermCallback");
        } else {
            launch(call);
        }
    }

    @PermissionCallback
    private void notificationsPermCallback(PluginCall call) {
        // Started either way: the connection is useful even if the user declined,
        // the notifications just stay silent.
        launch(call);
    }

    private void launch(PluginCall call) {
        Context context = getContext();
        Intent intent = new Intent(context, KeepAliveService.class);
        intent.setAction(KeepAliveService.ACTION_START);
        intent.putExtra(KeepAliveService.EXTRA_BASE, call.getString("base"));
        intent.putExtra(KeepAliveService.EXTRA_TOKEN, call.getString("token"));
        ContextCompat.startForegroundService(context, intent);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context context = getContext();
        context.stopService(new Intent(context, KeepAliveService.class));
        call.resolve();
    }

    /** Mirrors what the WebView is showing, so a completion the user is already
     *  looking at does not also buzz the phone. */
    @PluginMethod
    public void setContext(PluginCall call) {
        String stdinId = call.getString("stdinId");
        boolean foreground = Boolean.TRUE.equals(call.getBoolean("foreground"));
        KeepAliveService.setContext(stdinId, foreground);
        call.resolve();
    }

    /** Pushes a session id handed over by a notification tap. Retained until JS
     *  subscribes, which is what makes a cold start from a notification land on
     *  the right conversation instead of the session list. */
    public void emitOpenSession(String sessionId) {
        JSObject payload = new JSObject();
        payload.put("session", sessionId);
        notifyListeners("openSession", payload, true);
    }

    private boolean needsNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false;
        return getPermissionState("notifications") != PermissionState.GRANTED;
    }
}
