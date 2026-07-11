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

    const resp = await fetch(url);
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

export function weatherToContext(weather) {
  if (!weather) return "";
  return `Current weather: ${weather.temperature}°F, ${weather.condition}. High ${weather.high}°F / Low ${weather.low}°F. Wind ${weather.windSpeed} mph. Sunset at ${weather.sunset}. Tomorrow: ${weather.tomorrowHigh}°F, ${weather.tomorrowCondition}.`;
}
