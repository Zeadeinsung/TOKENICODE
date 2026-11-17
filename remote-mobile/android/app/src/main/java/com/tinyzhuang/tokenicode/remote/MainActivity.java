package com.tinyzhuang.tokenicode.remote;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    /** Session id carried by the notification the user tapped. */
    public static final String EXTRA_OPEN_SESSION = "tk_open_session";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must happen before super.onCreate, which is where the bridge
        // enumerates the registered plugins.
        registerPlugin(KeepAlivePlugin.class);
        super.onCreate(savedInstanceState);
        // After super, so the bridge and the plugin exist: the handler reaches
        // for the plugin to push the id into JS.
        dispatchOpenSession(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        dispatchOpenSession(intent);
    }

    private void dispatchOpenSession(Intent intent) {
        if (intent == null) return;
        String session = intent.getStringExtra(EXTRA_OPEN_SESSION);
        if (session == null || session.isEmpty()) return;
        // Consumed here so a later normal launch does not replay the navigation.
        intent.removeExtra(EXTRA_OPEN_SESSION);

        PluginHandle handle = getBridge() == null ? null : getBridge().getPlugin("KeepAlive");
        if (handle != null && handle.getInstance() instanceof KeepAlivePlugin) {
            ((KeepAlivePlugin) handle.getInstance()).emitOpenSession(session);
        }
    }
}
