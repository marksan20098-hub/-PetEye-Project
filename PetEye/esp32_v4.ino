/*
  RASTREADOR GPS ESP32 + GY-GPS6MV2 -> SERVIDOR + ALARMA
  GPS TX -> D18 | GPS RX -> D5 | GPS VCC -> VIN | GPS GND -> GND
  Buzzer + -> D23 | Buzzer - -> D22 (hace de GND)

  La casa y el radio de la alarma se cambian desde la PÁGINA.
  El servidor se los manda a la placa, que los guarda en su memoria
  y los usa como respaldo si se queda sin internet.
*/

#include <WiFi.h>
#include <WiFiMulti.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <TinyGPSPlus.h>

// ====== CONFIGURÁ ESTO ======
struct Red { const char* ssid; const char* pass; };
Red REDES[] = {
  {"Familia Santacruz", "Damaris2023"},
  {"Wifi", "18122636"},
  // {"NOMBRE_3", "CLAVE_3"},    // espacios libres: sacá el // y completá
  // {"NOMBRE_4", "CLAVE_4"},
  // {"NOMBRE_5", "CLAVE_5"},
  // {"NOMBRE_6", "CLAVE_6"},
};

const char* SERVER_URL = "https://peteye-project.onrender.com/api/update";
const char* API_KEY    = "gps_f2e8ccba33bf32911832596349056a4c";

#define USAR_D22_COMO_GND true    // la pata - del buzzer va a D22
// ============================

#define RX_PIN 18
#define TX_PIN 5
#define GPS_BAUD 9600
#define BUZZER 23
const unsigned long INTERVALO = 5000;
const unsigned long REINTENTO_WIFI = 15000;
const unsigned long SIN_SERVIDOR_MS = 60000;   // sin respuesta => alarma de respaldo

WiFiMulti wifiMulti;
Preferences prefs;
TinyGPSPlus gps;
HardwareSerial SerialGPS(2);
unsigned long ultimoEnvio = 0, ultimoIntentoWiFi = 0, ultimaRespuesta = 0;

bool casaDefinida = false;
double casaLat = 0, casaLng = 0, casaRadio = 20;
double distCasa = -1;
int fuera = 0;
bool alarmaLocal = false;             // alarma de respaldo (sin servidor)
volatile bool sonarServidor = false;  // orden del servidor
volatile bool alarma = false;         // lo que usa el buzzer
volatile int bips = 0;

// El buzzer corre en una tarea aparte: suena aunque el WiFi esté ocupado
void tareaBuzzer(void* p) {
  for (;;) {
    if (bips > 0) {
      digitalWrite(BUZZER, HIGH); vTaskDelay(120 / portTICK_PERIOD_MS);
      digitalWrite(BUZZER, LOW);  vTaskDelay(120 / portTICK_PERIOD_MS);
      bips--;
    } else if (alarma) {
      digitalWrite(BUZZER, HIGH); vTaskDelay(300 / portTICK_PERIOD_MS);
      digitalWrite(BUZZER, LOW);  vTaskDelay(700 / portTICK_PERIOD_MS);
    } else {
      digitalWrite(BUZZER, LOW);  vTaskDelay(50 / portTICK_PERIOD_MS);
    }
  }
}

bool buenaSenal() {
  return gps.location.isValid() && gps.location.age() < 5000 &&
         gps.hdop.isValid() && gps.hdop.hdop() < 4.0;
}

// La casa llega desde la página; se guarda solo si cambió
void guardarCasa(double lat, double lng, double radio) {
  if (casaDefinida && lat == casaLat && lng == casaLng && radio == casaRadio) return;
  casaLat = lat; casaLng = lng; casaRadio = radio; casaDefinida = true;
  prefs.putBool("tiene", true);
  prefs.putDouble("lat", lat); prefs.putDouble("lng", lng); prefs.putDouble("radio", radio);
  Serial.printf(">>> CASA desde la pagina: %.6f, %.6f | radio %.0f m\n", lat, lng, radio);
}

void borrarCasa() {
  if (!casaDefinida) return;
  casaDefinida = false; alarmaLocal = false; fuera = 0;
  prefs.putBool("tiene", false);
  Serial.println(">>> Sin casa guardada en la pagina");
}

// Mide la distancia; solo suena por su cuenta si el servidor no responde
void revisarDistancia() {
  if (!casaDefinida || !gps.location.isUpdated() || !buenaSenal()) return;
  distCasa = TinyGPSPlus::distanceBetween(gps.location.lat(), gps.location.lng(), casaLat, casaLng);
  if (distCasa > casaRadio) {
    if (++fuera >= 3) alarmaLocal = true;
  } else {
    fuera = 0;
    if (distCasa < casaRadio * 0.8) alarmaLocal = false;
  }
}

// Prueba las redes guardadas y se conecta a la de mejor señal
void conectarWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("Buscando WiFi...");
  if (wifiMulti.run(8000) == WL_CONNECTED) {
    Serial.printf(" conectado a %s (%d dBm)\n", WiFi.SSID().c_str(), WiFi.RSSI());
  } else {
    Serial.println(" sin red");
  }
}

bool leerNum(const String& s, const char* clave, double& out) {
  int i = s.indexOf(clave);
  if (i < 0) return false;
  out = s.substring(i + strlen(clave)).toDouble();
  return true;
}

int enviar(bool fix) {
  if (WiFi.status() != WL_CONNECTED) return -2;

  char json[256];
  int rssi = WiFi.RSSI();
  if (fix) {
    snprintf(json, sizeof(json),
      "{\"fix\":true,\"lat\":%.6f,\"lng\":%.6f,\"speed\":%.1f,\"alt\":%.1f,\"sats\":%d,\"hdop\":%.1f,\"rssi\":%d}",
      gps.location.lat(), gps.location.lng(),
      gps.speed.isValid() ? gps.speed.kmph() : 0.0,
      gps.altitude.isValid() ? gps.altitude.meters() : 0.0,
      (int)gps.satellites.value(),
      gps.hdop.isValid() ? gps.hdop.hdop() : 99.0,
      rssi);
  } else {
    snprintf(json, sizeof(json), "{\"fix\":false,\"sats\":%d,\"rssi\":%d}",
      (int)gps.satellites.value(), rssi);
  }

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setTimeout(10000);
  int code = -1;
  if (http.begin(client, SERVER_URL)) {
    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-api-key", API_KEY);
    code = http.POST(json);
    if (code == 200) {
      String r = http.getString();
      ultimaRespuesta = millis();
      sonarServidor = (r.indexOf("\"sonar\":true") >= 0);
      int c = r.indexOf("\"casa\":{");
      if (c >= 0) {
        String t = r.substring(c);
        double a, b, d;
        if (leerNum(t, "\"lat\":", a) && leerNum(t, "\"lng\":", b) && leerNum(t, "\"radio\":", d)) guardarCasa(a, b, d);
      } else if (r.indexOf("\"casa\":null") >= 0) {
        borrarCasa();
      }
    }
    http.end();
  }
  return code;
}

void setup() {
  Serial.begin(115200);

  pinMode(BUZZER, OUTPUT);
  digitalWrite(BUZZER, LOW);
#if USAR_D22_COMO_GND
  pinMode(22, OUTPUT);
  digitalWrite(22, LOW);
#endif

  prefs.begin("gps", false);
  if (prefs.getBool("tiene", false)) {
    casaLat = prefs.getDouble("lat", 0);
    casaLng = prefs.getDouble("lng", 0);
    casaRadio = prefs.getDouble("radio", 20);
    casaDefinida = true;
    Serial.printf("Casa recordada: %.6f, %.6f | radio %.0f m\n", casaLat, casaLng, casaRadio);
  }

  SerialGPS.setRxBufferSize(1024);
  SerialGPS.begin(GPS_BAUD, SERIAL_8N1, RX_PIN, TX_PIN);
  xTaskCreate(tareaBuzzer, "buzzer", 2048, NULL, 1, NULL);
  bips = 1;   // pitido corto de arranque

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  for (unsigned i = 0; i < sizeof(REDES) / sizeof(REDES[0]); i++) {
    wifiMulti.addAP(REDES[i].ssid, REDES[i].pass);
  }
  conectarWiFi();
}

void loop() {
  while (SerialGPS.available() > 0) gps.encode(SerialGPS.read());
  revisarDistancia();

  // Con el servidor respondiendo, él decide; sin respuesta, manda el respaldo local
  bool servidorOk = ultimaRespuesta != 0 && millis() - ultimaRespuesta < SIN_SERVIDOR_MS;
  if (servidorOk) alarmaLocal = false;
  else sonarServidor = false;
  alarma = alarmaLocal || sonarServidor;

  if (WiFi.status() != WL_CONNECTED && millis() - ultimoIntentoWiFi > REINTENTO_WIFI) {
    ultimoIntentoWiFi = millis();
    conectarWiFi();
  }

  if (millis() - ultimoEnvio >= INTERVALO) {
    ultimoEnvio = millis();

    bool fix = gps.location.isValid() && gps.location.age() < 5000;
    int code = enviar(fix);

    if (fix) Serial.printf("GPS %d sat | %.6f, %.6f | casa: %.0f de %.0f m | %s | wifi %d dBm | envio: %d\n",
      (int)gps.satellites.value(), gps.location.lat(), gps.location.lng(),
      distCasa < 0 ? 0.0 : distCasa, casaDefinida ? casaRadio : 0.0, alarma ? "ALARMA" : "ok", WiFi.RSSI(), code);
    else Serial.printf("Sin fix | %d sat | wifi %d dBm | envio: %d\n",
      (int)gps.satellites.value(), WiFi.RSSI(), code);
  }
}
