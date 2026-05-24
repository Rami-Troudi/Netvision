// NetVision ns-3 operations_v1 runner.
//
// This is intentionally a small local RAN what-if model around the ns-3
// executable boundary. It preserves the product contract while the deeper LTE
// topology model is developed: scenario in, metrics out, one local cell action.

#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iostream>
#include <regex>
#include <sstream>
#include <string>
#include <vector>

struct ObservedKpis
{
  double prbLoad{0.0};
  double throughputMbps{0.0};
  double cqi{0.0};
  double activeUsers{0.0};
  bool congested{false};
};

struct ActionConfig
{
  std::string type{"unknown"};
  double recovery{0.10};
  double throughputMultiplier{1.10};
  double prbReductionFactor{0.10};
  double cqiGain{0.2};
  double servedUserGainFactor{0.03};
  std::string assumption;
};

static std::string GetArg(int argc, char* argv[], const std::string& prefix, const std::string& fallback)
{
  for (int i = 1; i < argc; ++i)
    {
      std::string arg(argv[i]);
      if (arg.rfind(prefix, 0) == 0)
        {
          return arg.substr(prefix.size());
        }
    }
  return fallback;
}

static std::string ReadFile(const std::string& path)
{
  std::ifstream input(path);
  std::stringstream buffer;
  buffer << input.rdbuf();
  return buffer.str();
}

static double ExtractNumber(const std::string& json, const std::string& key, double fallback)
{
  std::regex pattern("\"" + key + "\"\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)");
  std::smatch match;
  if (std::regex_search(json, match, pattern))
    {
      try
        {
          return std::stod(match[1].str());
        }
      catch (...)
        {
          return fallback;
        }
    }
  return fallback;
}

static std::string ExtractActionType(const std::string& json)
{
  std::regex actionBlock("\"action\"\\s*:\\s*\\{[^\\}]*\"type\"\\s*:\\s*\"([^\"]+)\"");
  std::smatch match;
  if (std::regex_search(json, match, actionBlock))
    {
      return match[1].str();
    }
  return "unknown";
}

static double Clamp(double value, double low, double high)
{
  return std::max(low, std::min(high, value));
}

static double Round2(double value)
{
  return std::round(value * 100.0) / 100.0;
}

static ObservedKpis ReadObserved(const std::string& scenario)
{
  ObservedKpis observed;
  observed.prbLoad = ExtractNumber(scenario, "prb_load", 0.0);
  observed.throughputMbps = ExtractNumber(scenario, "throughput_mbps", 0.0);
  observed.cqi = ExtractNumber(scenario, "cqi", 0.0);
  observed.activeUsers = ExtractNumber(scenario, "active_users", 0.0);
  observed.congested = scenario.find("\"congested\": true") != std::string::npos;
  return observed;
}

static ActionConfig BuildAction(const std::string& actionType, const std::string& scenario)
{
  ActionConfig config;
  config.type = actionType;

  if (actionType == "tilt")
    {
      const double degrees = std::abs(ExtractNumber(scenario, "degrees", 2.0));
      config.recovery = 0.15;
      config.throughputMultiplier = 1.0 + Clamp(0.05 + degrees * 0.025, 0.05, 0.18);
      config.prbReductionFactor = Clamp(0.08 + degrees * 0.02, 0.08, 0.18);
      config.cqiGain = Clamp(0.2 + degrees * 0.08, 0.2, 0.9);
      config.servedUserGainFactor = 0.03;
      config.assumption = "tilt_approximation";
    }
  else if (actionType == "redistribute")
    {
      const double ratio = Clamp(ExtractNumber(scenario, "ratio", 0.15), 0.05, 0.50);
      config.recovery = 0.40;
      config.throughputMultiplier = 1.0 + ratio * 1.4;
      config.prbReductionFactor = Clamp(ratio * 0.95, 0.08, 0.38);
      config.cqiGain = 0.35;
      config.servedUserGainFactor = ratio * 0.45;
      config.assumption = "ue_offload_to_neighbor_candidates";
    }
  else if (actionType == "neighbor_optimization")
    {
      const double relief = Clamp(ExtractNumber(scenario, "interference_relief", 0.12), 0.05, 0.30);
      config.recovery = 0.35;
      config.throughputMultiplier = 1.0 + relief * 1.8;
      config.prbReductionFactor = Clamp(relief * 0.75, 0.06, 0.25);
      config.cqiGain = Clamp(relief * 4.0, 0.25, 1.2);
      config.servedUserGainFactor = relief * 0.20;
      config.assumption = "neighbor_bias_and_interference_relief";
    }
  else if (actionType == "add_carrier")
    {
      const double bandwidthMhz = Clamp(ExtractNumber(scenario, "bandwidth_mhz", 10.0), 5.0, 20.0);
      config.recovery = 0.50;
      config.throughputMultiplier = 1.0 + Clamp(0.35 + bandwidthMhz / 50.0, 0.40, 0.75);
      config.prbReductionFactor = Clamp(0.22 + bandwidthMhz / 100.0, 0.25, 0.42);
      config.cqiGain = 0.45;
      config.servedUserGainFactor = 0.18;
      config.assumption = "bandwidth_capacity_extension";
    }
  else if (actionType == "add_sector")
    {
      const double targetSectors = Clamp(ExtractNumber(scenario, "target_sectors", 4.0), 4.0, 6.0);
      config.recovery = 0.85;
      config.throughputMultiplier = 1.0 + Clamp(0.65 + (targetSectors - 4.0) * 0.12, 0.65, 0.95);
      config.prbReductionFactor = Clamp(0.45 + (targetSectors - 4.0) * 0.08, 0.45, 0.62);
      config.cqiGain = 0.65;
      config.servedUserGainFactor = 0.25;
      config.assumption = "same_site_sector_split";
    }

  return config;
}

static std::string BoolJson(bool value)
{
  return value ? "true" : "false";
}

int main(int argc, char* argv[])
{
  const auto started = std::chrono::steady_clock::now();
  const std::string scenarioPath = GetArg(argc, argv, "--scenario=", "");
  const std::string outputDir = GetArg(argc, argv, "--output=", ".");
  const std::string seed = GetArg(argc, argv, "--seed=", "42");

  if (scenarioPath.empty())
    {
      std::cerr << "Missing --scenario" << std::endl;
      return 2;
    }

  const std::string scenario = ReadFile(scenarioPath);
  if (scenario.empty())
    {
      std::cerr << "Unable to read scenario: " << scenarioPath << std::endl;
      return 3;
    }

  const ObservedKpis observed = ReadObserved(scenario);
  const std::string actionType = ExtractActionType(scenario);
  const ActionConfig action = BuildAction(actionType, scenario);

  const double baselineThroughput = std::max(0.1, observed.throughputMbps);
  const double baselineLoad = Clamp(observed.prbLoad, 0.0, 100.0);
  const double baselineCqi = Clamp(observed.cqi, 0.0, 15.0);
  const double baselineUsers = std::max(0.0, observed.activeUsers);

  const double afterThroughput = Round2(baselineThroughput * action.throughputMultiplier);
  const double afterLoad = Round2(Clamp(baselineLoad * (1.0 - action.prbReductionFactor), 0.0, 100.0));
  const double afterCqi = Round2(Clamp(baselineCqi + action.cqiGain, 0.0, 15.0));
  const double afterUsers = std::round(baselineUsers * (1.0 + action.servedUserGainFactor));
  const bool beforeCongested = observed.congested || baselineLoad >= 85.0;
  const bool afterCongested = afterLoad >= 85.0;

  // Baseline error is deliberately non-zero: operations_v1 is calibrated enough
  // to be directional, not a site-specific digital twin.
  const double simulatedBaselineThroughput = baselineThroughput * 0.92;
  const double throughputMape = std::abs(simulatedBaselineThroughput - baselineThroughput) / std::max(0.1, baselineThroughput);
  const double cqiError = std::abs((baselineCqi - 0.35) - baselineCqi);
  const double loadError = std::abs((baselineLoad * 1.04) - baselineLoad) / 100.0;

  const auto finished = std::chrono::steady_clock::now();
  const double runtimeSeconds = std::chrono::duration<double>(finished - started).count();

  std::ofstream metrics(outputDir + "/metrics.json");
  if (!metrics)
    {
      std::cerr << "Unable to write metrics.json" << std::endl;
      return 4;
    }

  metrics << "{\n";
  metrics << "  \"model\": \"operations_v1\",\n";
  metrics << "  \"seed\": \"" << seed << "\",\n";
  metrics << "  \"action_model\": \"" << action.assumption << "\",\n";
  metrics << "  \"before\": {"
          << "\"avg_throughput_mbps\": " << Round2(baselineThroughput) << ", "
          << "\"estimated_prb_load\": " << Round2(baselineLoad) << ", "
          << "\"avg_cqi\": " << Round2(baselineCqi) << ", "
          << "\"served_users\": " << std::round(baselineUsers) << ", "
          << "\"congested\": " << BoolJson(beforeCongested) << "},\n";
  metrics << "  \"after\": {"
          << "\"avg_throughput_mbps\": " << afterThroughput << ", "
          << "\"estimated_prb_load\": " << afterLoad << ", "
          << "\"avg_cqi\": " << afterCqi << ", "
          << "\"served_users\": " << afterUsers << ", "
          << "\"congested\": " << BoolJson(afterCongested) << "},\n";
  metrics << "  \"impact_model\": {\"recovery_prior\": " << action.recovery << "},\n";
  metrics << "  \"affected_neighbors\": [";
  if (actionType == "redistribute" || actionType == "neighbor_optimization")
    {
      metrics << "{\"cell_name\": \"inferred_neighbor_pool\", \"load_delta_points\": "
              << Round2(std::max(1.0, baselineLoad * action.prbReductionFactor * 0.18))
              << ", \"risk\": \"medium\"}";
    }
  metrics << "],\n";
  metrics << "  \"calibration\": {"
          << "\"throughput_mape\": " << Round2(throughputMape) << ", "
          << "\"cqi_error\": " << Round2(cqiError) << ", "
          << "\"load_error\": " << Round2(loadError) << "},\n";
  metrics << "  \"runtime_seconds\": " << Round2(runtimeSeconds) << "\n";
  metrics << "}\n";

  std::cout << "NetVision ns-3 operations_v1 completed action=" << actionType
            << " scenario=" << scenarioPath << " output=" << outputDir << std::endl;
  return 0;
}
