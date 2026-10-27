package app.forest.aircon;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {

    private static final String PREFS = "forest_aircon";
    private static final String UNASSIGNED = "미지정";

    private SharedPreferences prefs;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private EditText tokenInput;
    private LinearLayout roomsBox;
    private TextView logView;
    private final StringBuilder logText = new StringBuilder();

    private final List<ThinqClient.Device> devices = new ArrayList<>();
    private final Map<String, String> roomOf = new LinkedHashMap<>();
    private volatile boolean busy = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        loadCache();
        buildUi();
        renderRooms();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        io.shutdown();
    }

    // ------------------------------------------------------------------ 저장/불러오기

    private String clientId() {
        String id = prefs.getString("client_id", null);
        if (id == null) {
            id = ThinqClient.newClientId();
            prefs.edit().putString("client_id", id).apply();
        }
        return id;
    }

    private ThinqClient client() {
        return new ThinqClient(prefs.getString("pat", ""), clientId());
    }

    private void loadCache() {
        devices.clear();
        roomOf.clear();
        try {
            JSONArray arr = new JSONArray(prefs.getString("devices", "[]"));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                devices.add(new ThinqClient.Device(o.getString("id"), o.optString("alias"),
                        o.optString("type"), o.optString("model")));
            }
            JSONObject rooms = new JSONObject(prefs.getString("rooms", "{}"));
            java.util.Iterator<String> it = rooms.keys();
            while (it.hasNext()) {
                String k = it.next();
                roomOf.put(k, rooms.getString(k));
            }
        } catch (JSONException ignored) {
        }
    }

    private void saveDevices() {
        JSONArray arr = new JSONArray();
        try {
            for (ThinqClient.Device d : devices) {
                JSONObject o = new JSONObject();
                o.put("id", d.id);
                o.put("alias", d.alias);
                o.put("type", d.type);
                o.put("model", d.model);
                arr.put(o);
            }
        } catch (JSONException ignored) {
        }
        prefs.edit().putString("devices", arr.toString()).apply();
    }

    private void saveRooms() {
        JSONObject o = new JSONObject();
        try {
            for (Map.Entry<String, String> e : roomOf.entrySet()) {
                o.put(e.getKey(), e.getValue());
            }
        } catch (JSONException ignored) {
        }
        prefs.edit().putString("rooms", o.toString()).apply();
    }

    // ------------------------------------------------------------------ 화면

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    private Button button(String text, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setOnClickListener(l);
        return b;
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(24), dp(16), dp(24));
        scroll.addView(root);

        TextView title = new TextView(this);
        title.setText("산림치유센터 에어컨");
        title.setTextSize(22);
        title.setTextColor(Color.BLACK);
        root.addView(title);

        TextView tokenLabel = new TextView(this);
        tokenLabel.setText("ThinQ 토큰(PAT)");
        tokenLabel.setPadding(0, dp(12), 0, 0);
        root.addView(tokenLabel);

        tokenInput = new EditText(this);
        tokenInput.setHint("thinqpat_...");
        tokenInput.setSingleLine(true);
        tokenInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        String saved = prefs.getString("pat", "");
        if (!saved.isEmpty()) {
            tokenInput.setText(saved);
        }
        root.addView(tokenInput);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.addView(button("토큰 저장", v -> {
            prefs.edit().putString("pat", tokenInput.getText().toString().trim()).apply();
            log("토큰을 저장했습니다.");
        }), weight());
        row.addView(button("기기 불러오기", v -> reloadDevices()), weight());
        root.addView(row);

        TextView allLabel = new TextView(this);
        allLabel.setText("전체");
        allLabel.setTextSize(16);
        allLabel.setTextColor(Color.BLACK);
        allLabel.setPadding(0, dp(16), 0, 0);
        root.addView(allLabel);
        root.addView(actionRow("전체", new Group() {
            public List<ThinqClient.Device> list() {
                return acList();
            }
        }, false));

        roomsBox = new LinearLayout(this);
        roomsBox.setOrientation(LinearLayout.VERTICAL);
        root.addView(roomsBox);

        TextView logTitle = new TextView(this);
        logTitle.setText("기록");
        logTitle.setTextSize(16);
        logTitle.setTextColor(Color.BLACK);
        logTitle.setPadding(0, dp(20), 0, 0);
        root.addView(logTitle);

        logView = new TextView(this);
        logView.setTextSize(13);
        logView.setTextIsSelectable(true);
        root.addView(logView);

        setContentView(scroll);
    }

    private LinearLayout.LayoutParams weight() {
        return new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
    }

    private interface Group {
        List<ThinqClient.Device> list();
    }

    private LinearLayout actionRow(final String name, final Group g, boolean withTemp) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.addView(button("켜기", v -> confirmPower(name, g.list(), true)), weight());
        row.addView(button("끄기", v -> confirmPower(name, g.list(), false)), weight());
        row.addView(button("점검", v -> runCheck(name, g.list())), weight());
        if (withTemp) {
            row.addView(button("온도", v -> askTemperature(name, g.list())), weight());
        }
        return row;
    }

    private List<ThinqClient.Device> acList() {
        List<ThinqClient.Device> out = new ArrayList<>();
        for (ThinqClient.Device d : devices) {
            if (d.isAirConditioner()) {
                out.add(d);
            }
        }
        return out;
    }

    private String roomName(ThinqClient.Device d) {
        String r = roomOf.get(d.id);
        return (r == null || r.trim().isEmpty()) ? UNASSIGNED : r.trim();
    }

    private void renderRooms() {
        roomsBox.removeAllViews();
        List<ThinqClient.Device> acs = acList();
        if (acs.isEmpty()) {
            TextView t = new TextView(this);
            t.setText("\n등록된 에어컨이 없습니다. 토큰을 저장한 뒤 '기기 불러오기'를 눌러주세요.");
            roomsBox.addView(t);
            return;
        }
        Map<String, List<ThinqClient.Device>> byRoom = new LinkedHashMap<>();
        for (ThinqClient.Device d : acs) {
            String r = roomName(d);
            if (!byRoom.containsKey(r)) {
                byRoom.put(r, new ArrayList<ThinqClient.Device>());
            }
            byRoom.get(r).add(d);
        }
        for (Map.Entry<String, List<ThinqClient.Device>> e : byRoom.entrySet()) {
            final String room = e.getKey();
            final List<ThinqClient.Device> members = e.getValue();

            TextView head = new TextView(this);
            head.setText(room + " (" + members.size() + "대)");
            head.setTextSize(17);
            head.setTextColor(Color.BLACK);
            head.setPadding(0, dp(18), 0, 0);
            roomsBox.addView(head);

            roomsBox.addView(actionRow(room, () -> members, true));

            for (final ThinqClient.Device d : members) {
                LinearLayout line = new LinearLayout(this);
                line.setOrientation(LinearLayout.HORIZONTAL);
                line.setGravity(Gravity.CENTER_VERTICAL);
                TextView n = new TextView(this);
                n.setText("· " + d.alias);
                line.addView(n, weight());
                Button b = button("방 지정", v -> askRoom(d));
                b.setTextSize(12);
                line.addView(b);
                roomsBox.addView(line);
            }
        }
    }

    // ------------------------------------------------------------------ 동작

    private void log(final String msg) {
        final String line = new SimpleDateFormat("HH:mm:ss", Locale.KOREA).format(new Date())
                + "  " + msg + "\n";
        runOnUiThread(() -> {
            logText.insert(0, line);
            if (logText.length() > 6000) {
                logText.setLength(6000);
            }
            logView.setText(logText.toString());
        });
    }

    private void reloadDevices() {
        if (!startBusy()) {
            return;
        }
        prefs.edit().putString("pat", tokenInput.getText().toString().trim()).apply();
        log("기기 목록을 불러오는 중...");
        io.execute(() -> {
            try {
                List<ThinqClient.Device> list = client().listDevices();
                runOnUiThread(() -> {
                    devices.clear();
                    devices.addAll(list);
                    saveDevices();
                    renderRooms();
                });
                int ac = 0;
                for (ThinqClient.Device d : list) {
                    if (d.isAirConditioner()) {
                        ac++;
                    }
                }
                log("기기 " + list.size() + "개 (에어컨 " + ac + "대)");
            } catch (ThinqClient.ThinqException e) {
                log("불러오기 실패: " + e.getMessage());
            } finally {
                busy = false;
            }
        });
    }

    private boolean startBusy() {
        if (busy) {
            log("이전 작업이 진행 중입니다. 잠시만 기다려주세요.");
            return false;
        }
        busy = true;
        return true;
    }

    private void confirmPower(final String name, final List<ThinqClient.Device> list, final boolean on) {
        if (list.isEmpty()) {
            log(name + ": 대상 에어컨이 없습니다.");
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle(name + " " + (on ? "켜기" : "끄기"))
                .setMessage("에어컨 " + list.size() + "대를 " + (on ? "켤까요?" : "끌까요?"))
                .setPositiveButton("확인", (d, w) -> runPower(name, list, on))
                .setNegativeButton("취소", null)
                .show();
    }

    private void runPower(final String name, final List<ThinqClient.Device> list, final boolean on) {
        if (!startBusy()) {
            return;
        }
        log(name + " " + (on ? "켜기" : "끄기") + " 시작 (" + list.size() + "대)");
        io.execute(() -> {
            int ok = 0;
            try {
                ThinqClient c = client();
                for (ThinqClient.Device d : list) {
                    try {
                        c.setPower(d.id, on);
                        ok++;
                        log("  " + d.alias + ": 완료");
                    } catch (ThinqClient.ThinqException e) {
                        log("  " + d.alias + ": 실패 - " + e.getMessage());
                    }
                    pause();
                }
            } finally {
                busy = false;
            }
            log(name + " " + (on ? "켜기" : "끄기") + " 끝: " + ok + "/" + list.size() + " 성공");
        });
    }

    private void runCheck(final String name, final List<ThinqClient.Device> list) {
        if (list.isEmpty()) {
            log(name + ": 대상 에어컨이 없습니다.");
            return;
        }
        if (!startBusy()) {
            return;
        }
        log(name + " 점검 시작");
        io.execute(() -> {
            try {
                ThinqClient c = client();
                for (ThinqClient.Device d : list) {
                    try {
                        JSONObject st = c.getState(d.id);
                        log("  " + d.alias + ": " + c.summarize(st));
                    } catch (ThinqClient.ThinqException e) {
                        log("  " + d.alias + ": 실패 - " + e.getMessage());
                    }
                    pause();
                }
            } finally {
                busy = false;
            }
            log(name + " 점검 끝");
        });
    }

    private void askTemperature(final String name, final List<ThinqClient.Device> list) {
        if (list.isEmpty()) {
            log(name + ": 대상 에어컨이 없습니다.");
            return;
        }
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
        input.setHint("예: 24");
        new AlertDialog.Builder(this)
                .setTitle(name + " 설정 온도(°C)")
                .setView(input)
                .setPositiveButton("적용", (d, w) -> {
                    double t;
                    try {
                        t = Double.parseDouble(input.getText().toString().trim());
                    } catch (NumberFormatException e) {
                        log("온도 값이 올바르지 않습니다.");
                        return;
                    }
                    if (t < 16 || t > 30) {
                        log("온도는 16~30 사이로 입력해주세요.");
                        return;
                    }
                    runTemperature(name, list, t);
                })
                .setNegativeButton("취소", null)
                .show();
    }

    private void runTemperature(final String name, final List<ThinqClient.Device> list, final double t) {
        if (!startBusy()) {
            return;
        }
        log(name + " 온도 " + t + "°C 설정 시작");
        io.execute(() -> {
            int ok = 0;
            try {
                ThinqClient c = client();
                for (ThinqClient.Device d : list) {
                    try {
                        c.setTemperature(d.id, t);
                        ok++;
                        log("  " + d.alias + ": 완료");
                    } catch (ThinqClient.ThinqException e) {
                        log("  " + d.alias + ": 실패 - " + e.getMessage());
                    }
                    pause();
                }
            } finally {
                busy = false;
            }
            log(name + " 온도 설정 끝: " + ok + "/" + list.size() + " 성공");
        });
    }

    private void askRoom(final ThinqClient.Device d) {
        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint("예: 치유실1");
        String cur = roomOf.get(d.id);
        if (cur != null) {
            input.setText(cur);
        }
        new AlertDialog.Builder(this)
                .setTitle(d.alias + " 방 지정")
                .setMessage("같은 방 이름을 입력한 에어컨끼리 묶입니다.")
                .setView(input)
                .setPositiveButton("저장", (dlg, w) -> {
                    String r = input.getText().toString().trim();
                    if (r.isEmpty()) {
                        roomOf.remove(d.id);
                    } else {
                        roomOf.put(d.id, r);
                    }
                    saveRooms();
                    renderRooms();
                })
                .setNegativeButton("취소", null)
                .show();
    }

    private void pause() {
        try {
            Thread.sleep(400);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
