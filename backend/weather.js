/**
 * Argus Weather Service — Open-Meteo (no API key needed)
 */

const weatherCache = new Map(); // "lat,lon" (rounded) -> { data, time }
const CACHE_DURATION = 30 * 60 * 1000; // 30 min

export async function getWeather(
  lat = parseFloat(process.env.WEATHER_LAT) || 41.88,
  lon = parseFloat(process.env.WEATHER_LON) || -87.63
) {
  const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const now = Date.now();
  const cached = weatherCache.get(cacheKey);
  if (cached && now - cached.time < CACHE_DURATION) {
    return cached.data;
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weathercode,windspeed_10m,relative_humidity_2m&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset,weathercode&temperature_unit=fahrenheit&timezone=auto&forecast_days=2`;

    // Unlike the geo lookup (which has an explicit 3s AbortSignal.timeout),
    // this fetch previously had no timeout at all — a slow/hanging
    // Open-Meteo response could silently stretch connection-open latency
    // past what every other stage in buildSystemInstruction is bounded by.
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const data = await resp.json();

    const current = data.current;
    const daily = data.daily;

    const weatherCodes = {
      0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
      45: "foggy", 48: "freezing fog", 51: "light drizzle", 53: "drizzle",
      55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
      71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers",
      81: "heavy rain showers", 95: "thunderstorm",
    };

    const weather = {
      temperature: Math.round(current.temperature_2m),
      condition: weatherCodes[current.weathercode] || "unknown",
      humidity: current.relative_humidity_2m,
      windSpeed: Math.round(current.windspeed_10m),
      high: Math.round(daily.temperature_2m_max[0]),
      low: Math.round(daily.temperature_2m_min[0]),
      sunrise: daily.sunrise[0],
      sunset: daily.sunset[0],
      tomorrowHigh: Math.round(daily.temperature_2m_max[1]),
      tomorrowLow: Math.round(daily.temperature_2m_min[1]),
      tomorrowCondition: weatherCodes[daily.weathercode[1]] || "unknown",
    };
    weatherCache.set(cacheKey, { data: weather, time: now });

    return weather;
  } catch (err) {
    console.error("Weather fetch error:", err.message);
    return null;
  }
}

// Resolves a free-text city ("Milwaukee, Wisconsin") to coordinates via
// Open-Meteo's geocoding API — same provider as the forecast above, no API
// key, so this adds no new dependency or credential. Cached indefinitely
// per query string: a city's coordinates don't change, and the input space
// is tiny (one per user, set at setup or when they move).
//
// Home coordinates matter because IP geolocation only ever says where the
// user is *right now*. Storing home separately is what lets Argus tell
// "you're home" from "you're travelling" (see buildSystemInstruction).
const geocodeCache = new Map();

export async function geocodeCity(city) {
  const key = String(city || "").trim().toLowerCase();
  if (!key) return null;
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&format=json`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const data = await resp.json();
    const hit = data && data.results && data.results[0];
    if (!hit) return null;
    const lat = Number(hit.latitude), lon = Number(hit.longitude);
    // Same validation shape as the IP-geo path in server.js — never let an
    // unvalidated coordinate reach the forecast URL.
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const result = { lat, lon };
    geocodeCache.set(key, result);
    return result;
  } catch (err) {
    console.warn("Geocode failed:", err.message);
    return null;
  }
}

// Great-circle distance in miles. Used only to decide the home/away phrasing
// in the system instruction, so precision beyond a few miles is irrelevant.
export function distanceMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function weatherToContext(weather) {
  if (!weather) return "";
  return `Current weather: ${weather.temperature}°F, ${weather.condition}. High ${weather.high}°F / Low ${weather.low}°F. Wind ${weather.windSpeed} mph. Sunset at ${weather.sunset}. Tomorrow: ${weather.tomorrowHigh}°F, ${weather.tomorrowCondition}.`;
}
