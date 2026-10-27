package app.forest.aircon;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

/**
 * LG ThinQ Connect API (개인 PAT 방식) 최소 클라이언트. 외부 라이브러리 없음.
 */
public class ThinqClient {

    public static final String BASE_URL = "https://api-kic.lgthinq.com"; // 한국/동아시아
    public static final String COUNTRY = "KR";
    private static final String API_KEY = "v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3";

    public static class Device {
        public final String id;
        public final String alias;
        public final String type;
        public final String model;

        public Device(String id, String alias, String type, String model) {
            this.id = id;
            this.alias = alias;
            this.type = type;
            this.model = model;
        }

        public boolean isAirConditioner() {
            return type != null && type.toUpperCase().contains("AIR_CONDITIONER");
        }
    }

    public static class ThinqException extends Exception {
        public final int httpCode;

        public ThinqException(String msg, int httpCode) {
            super(msg);
            this.httpCode = httpCode;
        }
    }

    private final String baseUrl;
    private final String pat;
    private final String clientId;

    public ThinqClient(String pat, String clientId) {
        this(BASE_URL, pat, clientId);
    }

    public ThinqClient(String baseUrl, String pat, String clientId) {
        this.baseUrl = baseUrl;
        this.pat = pat == null ? "" : pat.trim();
        this.clientId = clientId;
    }

    public static String newClientId() {
        return "forest-aircon-" + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
    }

    static String messageId() {
        UUID u = UUID.randomUUID();
        ByteBuffer bb = ByteBuffer.allocate(16);
        bb.putLong(u.getMostSignificantBits());
        bb.putLong(u.getLeastSignificantBits());
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bb.array());
    }

    private String request(String method, String path, String body, boolean control)
            throws ThinqException {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(baseUrl + path).openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            c.setRequestProperty("Authorization", "Bearer " + pat);
            c.setRequestProperty("x-message-id", messageId());
            c.setRequestProperty("x-country", COUNTRY);
            c.setRequestProperty("x-client-id", clientId);
            c.setRequestProperty("x-api-key", API_KEY);
            c.setRequestProperty("Accept", "application/json");
            if (control) {
                c.setRequestProperty("x-conditional-control", "true");
            }
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                byte[] data = body.getBytes(StandardCharsets.UTF_8);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(data);
                }
            }
            int code = c.getResponseCode();
            InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String text = is == null ? "" : readAll(is);
            if (code >= 400) {
                throw new ThinqException("HTTP " + code + " " + shorten(text), code);
            }
            return text;
        } catch (IOException e) {
            throw new ThinqException("네트워크 오류: " + e.getMessage(), -1);
        } finally {
            if (c != null) {
                c.disconnect();
            }
        }
    }

    private static String readAll(InputStream is) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = is.read(buf)) > 0) {
            bos.write(buf, 0, n);
        }
        is.close();
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String shorten(String s) {
        if (s == null) {
            return "";
        }
        s = s.replace("\n", " ");
        return s.length() > 200 ? s.substring(0, 200) + "..." : s;
    }

    /** 등록된 전체 기기 목록. */
    public List<Device> listDevices() throws ThinqException {
        String text = request("GET", "/devices", null, false);
        List<Device> out = new ArrayList<>();
        try {
            JSONObject root = new JSONObject(text);
            JSONArray arr = root.optJSONArray("response");
            if (arr == null) {
                JSONObject r = root.optJSONObject("response");
                if (r != null) {
                    arr = r.optJSONArray("devices");
                }
            }
            if (arr == null) {
                return out;
            }
            for (int i = 0; i < arr.length(); i++) {
                JSONObject d = arr.getJSONObject(i);
                JSONObject info = d.optJSONObject("deviceInfo");
                if (info == null) {
                    info = new JSONObject();
                }
                out.add(new Device(
                        d.optString("deviceId"),
                        info.optString("alias", d.optString("deviceId")),
                        info.optString("deviceType", ""),
                        info.optString("modelName", "")));
            }
        } catch (JSONException e) {
            throw new ThinqException("응답 해석 실패: " + shorten(text), -2);
        }
        return out;
    }

    /** 기기 상태 JSON(response 부분). */
    public JSONObject getState(String deviceId) throws ThinqException {
        String text = request("GET", "/devices/" + deviceId + "/state", null, false);
        try {
            JSONObject root = new JSONObject(text);
            JSONObject r = root.optJSONObject("response");
            if (r != null) {
                return r;
            }
            JSONArray a = root.optJSONArray("response");
            if (a != null && a.length() > 0) {
                return a.getJSONObject(0);
            }
            return root;
        } catch (JSONException e) {
            throw new ThinqException("상태 해석 실패: " + shorten(text), -2);
        }
    }

    public String getProfileRaw(String deviceId) throws ThinqException {
        return request("GET", "/devices/" + deviceId + "/profile", null, false);
    }

    private void control(String deviceId, JSONObject body) throws ThinqException {
        request("POST", "/devices/" + deviceId + "/control", body.toString(), true);
    }

    public void setPower(String deviceId, boolean on) throws ThinqException {
        try {
            JSONObject op = new JSONObject();
            op.put("airConOperationMode", on ? "POWER_ON" : "POWER_OFF");
            control(deviceId, new JSONObject().put("operation", op));
        } catch (JSONException e) {
            throw new ThinqException("요청 생성 실패", -3);
        }
    }

    /** 목표 온도 설정. targetTemperature 실패 시 coolTargetTemperature로 재시도. */
    public void setTemperature(String deviceId, double temp) throws ThinqException {
        try {
            JSONObject t = new JSONObject();
            t.put("targetTemperature", temp);
            t.put("unit", "C");
            control(deviceId, new JSONObject().put("temperature", t));
        } catch (ThinqException first) {
            if (first.httpCode < 400 || first.httpCode >= 500) {
                throw first;
            }
            try {
                JSONObject t = new JSONObject();
                t.put("coolTargetTemperature", temp);
                t.put("unit", "C");
                control(deviceId, new JSONObject().put("temperature", t));
            } catch (JSONException e) {
                throw new ThinqException("요청 생성 실패", -3);
            }
        } catch (JSONException e) {
            throw new ThinqException("요청 생성 실패", -3);
        }
    }

    /** 점검용 한 줄 요약. */
    public String summarize(JSONObject st) {
        String power = pick(st, "operation", "airConOperationMode");
        String mode = pick(st, "airConJobMode", "currentJobMode");
        String cur = pick(st, "temperature", "currentTemperature");
        String tgt = pick(st, "temperature", "targetTemperature");
        if (tgt.isEmpty()) {
            tgt = pick(st, "temperature", "coolTargetTemperature");
        }
        String p = power.equals("POWER_ON") ? "켜짐" : power.equals("POWER_OFF") ? "꺼짐" : (power.isEmpty() ? "?" : power);
        StringBuilder sb = new StringBuilder(p);
        if (!mode.isEmpty()) {
            sb.append(" / ").append(mode);
        }
        if (!cur.isEmpty()) {
            sb.append(" / 현재 ").append(cur).append("°");
        }
        if (!tgt.isEmpty()) {
            sb.append(" / 설정 ").append(tgt).append("°");
        }
        return sb.toString();
    }

    private static String pick(JSONObject st, String group, String key) {
        JSONObject g = st.optJSONObject(group);
        if (g == null) {
            return "";
        }
        Object v = g.opt(key);
        if (v == null || v == JSONObject.NULL) {
            return "";
        }
        String s = String.valueOf(v);
        if (s.endsWith(".0")) {
            s = s.substring(0, s.length() - 2);
        }
        return s;
    }
}
