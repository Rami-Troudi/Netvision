/*
 * Orange Digital Twin - LTE Network Simulator
 * ns-3 scenario for precise action estimation
 *
 * Compile: ./ns3 run scratch/orange-lte-sim -- --config=input.json --output=results.json
 */

#include "ns3/core-module.h"
#include "ns3/network-module.h"
#include "ns3/mobility-module.h"
#include "ns3/lte-module.h"
#include "ns3/internet-module.h"
#include "ns3/point-to-point-module.h"
#include "ns3/applications-module.h"
#include "ns3/config-store-module.h"
#include "ns3/flow-monitor-module.h"
#include <nlohmann/json.hpp>
#include <fstream>
#include <map>
#include <cmath>

using namespace ns3;
using json = nlohmann::json;

NS_LOG_COMPONENT_DEFINE("OrangeLteSim");

// ============================================================================
// KPI Collection Structures
// ============================================================================

struct CellKpi {
    uint16_t cellId = 0;
    std::string cellName;
    uint32_t userCount = 0;
    double totalThroughputKbps = 0.0;
    double avgSinrDb = 0.0;
    double avgCqi = 0.0;
    uint32_t prbUsed = 0;
    uint32_t prbTotal = 100;  // 20MHz = 100 PRBs
    uint32_t handoverIn = 0;
    uint32_t handoverOut = 0;
    std::vector<double> sinrSamples;
    std::vector<uint8_t> cqiSamples;
};

std::map<uint16_t, CellKpi> g_cellKpis;
std::map<uint64_t, uint16_t> g_ueToCell;  // IMSI -> CellId

// ============================================================================
// Trace Callbacks
// ============================================================================

void NotifyDlScheduling(uint16_t cellId, uint64_t imsi, uint16_t rnti,
                         uint8_t mcsTb1, uint16_t sizeTb1) {
    g_cellKpis[cellId].prbUsed++;
    g_cellKpis[cellId].totalThroughputKbps += (sizeTb1 * 8.0 / 1000.0);  // bits to kbps
}

void NotifyCqiReport(uint16_t cellId, uint16_t rnti, uint8_t cqi) {
    if (cqi > 0 && cqi <= 15) {
        g_cellKpis[cellId].cqiSamples.push_back(cqi);
        // Exponential moving average
        double alpha = 0.1;
        g_cellKpis[cellId].avgCqi = (1 - alpha) * g_cellKpis[cellId].avgCqi + alpha * cqi;
    }
}

void NotifySinr(uint16_t cellId, uint16_t rnti, double sinrLinear) {
    double sinrDb = 10 * std::log10(sinrLinear);
    g_cellKpis[cellId].sinrSamples.push_back(sinrDb);
    double alpha = 0.1;
    g_cellKpis[cellId].avgSinrDb = (1 - alpha) * g_cellKpis[cellId].avgSinrDb + alpha * sinrDb;
}

void NotifyHandover(std::string context, uint64_t imsi, uint16_t cellId,
                     uint16_t rnti, uint16_t targetCellId) {
    g_cellKpis[cellId].handoverOut++;
    g_cellKpis[targetCellId].handoverIn++;
    g_ueToCell[imsi] = targetCellId;
}

void NotifyConnectionEstablished(std::string context, uint64_t imsi,
                                  uint16_t cellId, uint16_t rnti) {
    g_cellKpis[cellId].userCount++;
    g_ueToCell[imsi] = cellId;
}

// ============================================================================
// Action Schedulers
// ============================================================================

void ActionTilt(Ptr<LteEnbNetDevice> enbDev, double newTiltDeg) {
    NS_LOG_INFO("Action: Changing tilt to " << newTiltDeg << " degrees");
    // Access antenna model and set tilt
    // Note: Actual implementation depends on antenna model used
    Config::Set("/NodeList/*/DeviceList/*/$ns3::LteEnbNetDevice/LteEnbPhy/AntennaModel/Tilt",
                DoubleValue(newTiltDeg));
}

void ActionPower(Ptr<LteEnbNetDevice> enbDev, double newPowerDbm) {
    NS_LOG_INFO("Action: Changing Tx power to " << newPowerDbm << " dBm");
    enbDev->GetPhy()->SetTxPower(newPowerDbm);
}

void ActionHandover(Ptr<LteHelper> lteHelper, Ptr<LteUeNetDevice> ueDev,
                     Ptr<LteEnbNetDevice> targetEnb) {
    NS_LOG_INFO("Action: Triggering handover");
    lteHelper->HandoverRequest(Seconds(0.1), ueDev, ueDev->GetRrc()->GetCellId(),
                               targetEnb->GetCellId());
}

// ============================================================================
// Utility Functions
// ============================================================================

double BandToEarfcn(uint32_t bandMhz) {
    // Simplified EARFCN mapping
    if (bandMhz == 700) return 2850;
    if (bandMhz == 800) return 3450;
    if (bandMhz == 900) return 3625;
    if (bandMhz == 1800) return 1300;
    if (bandMhz == 2100) return 100;
    if (bandMhz == 2600) return 3000;
    return 1300;  // Default to 1800 MHz
}

double BandToBandwidthRbs(uint32_t bandMhz) {
    // Most bands use 20 MHz = 100 RBs
    return 100;
}

// ============================================================================
// Main Simulation
// ============================================================================

int main(int argc, char* argv[]) {
    std::string configFile = "config.json";
    std::string outputFile = "results.json";
    double simulationTime = 10.0;  // seconds

    CommandLine cmd;
    cmd.AddValue("config", "Input JSON configuration", configFile);
    cmd.AddValue("output", "Output JSON results", outputFile);
    cmd.AddValue("time", "Simulation duration (s)", simulationTime);
    cmd.Parse(argc, argv);

    // ========================================================================
    // Load Configuration
    // ========================================================================
    std::ifstream configStream(configFile);
    if (!configStream.is_open()) {
        std::cerr << "Error: Cannot open config file: " << configFile << std::endl;
        return 1;
    }
    json config = json::parse(configStream);
    configStream.close();

    NS_LOG_INFO("Loaded configuration with " << config["sites"].size() << " sites");

    // ========================================================================
    // Create LTE Helpers
    // ========================================================================
    Ptr<LteHelper> lteHelper = CreateObject<LteHelper>();
    Ptr<PointToPointEpcHelper> epcHelper = CreateObject<PointToPointEpcHelper>();
    lteHelper->SetEpcHelper(epcHelper);

    // Set propagation model (COST231 for urban macro)
    lteHelper->SetAttribute("PathlossModel", StringValue("ns3::Cost231PropagationLossModel"));

    // Set fading model
    lteHelper->SetAttribute("FadingModel", StringValue("ns3::TraceFadingLossModel"));

    // Set scheduler (Proportional Fair is typical)
    lteHelper->SetSchedulerType("ns3::PfFfMacScheduler");

    // Configure antenna model for tilt support
    lteHelper->SetEnbAntennaModelType("ns3::CosineAntennaModel");
    lteHelper->SetEnbAntennaModelAttribute("VerticalBeamwidth", DoubleValue(65.0));
    lteHelper->SetEnbAntennaModelAttribute("HorizontalBeamwidth", DoubleValue(65.0));
    lteHelper->SetEnbAntennaModelAttribute("MaxGain", DoubleValue(18.0));

    // ========================================================================
    // Create Network Topology from Config
    // ========================================================================
    NodeContainer enbNodes;
    NodeContainer ueNodes;
    NetDeviceContainer enbDevices;
    NetDeviceContainer ueDevices;

    std::map<std::string, uint16_t> cellNameToId;
    uint16_t cellIdCounter = 1;

    for (auto& site : config["sites"]) {
        std::string siteName = site["enodeb_name"];
        double siteLon = site["lon"];
        double siteLat = site["lat"];

        for (auto& cell : site["cells"]) {
            std::string cellName = cell["cell_name"];
            uint32_t band = cell["band"];
            uint32_t pci = cell["pci"];
            double tilt = cell["tilt"];
            double azimuth = cell["azimuth"];
            uint32_t initialUsers = cell["initial_users"];

            // Create eNB node
            NodeContainer enbNode;
            enbNode.Create(1);
            enbNodes.Add(enbNode);

            // Set eNB position (convert lon/lat to meters if needed)
            MobilityHelper enbMobility;
            Ptr<ListPositionAllocator> enbPos = CreateObject<ListPositionAllocator>();
            enbPos->Add(Vector(siteLon, siteLat, 30.0));  // 30m tower height
            enbMobility.SetPositionAllocator(enbPos);
            enbMobility.SetMobilityModel("ns3::ConstantPositionMobilityModel");
            enbMobility.Install(enbNode);

            // Configure cell-specific parameters
            lteHelper->SetEnbAntennaModelAttribute("Orientation", DoubleValue(azimuth));
            lteHelper->SetEnbAntennaModelAttribute("Tilt", DoubleValue(tilt));
            lteHelper->SetEnbDeviceAttribute("DlEarfcn", UintegerValue(BandToEarfcn(band)));
            lteHelper->SetEnbDeviceAttribute("UlEarfcn", UintegerValue(BandToEarfcn(band) + 18000));
            lteHelper->SetEnbDeviceAttribute("DlBandwidth", UintegerValue(100));  // 20 MHz
            lteHelper->SetEnbDeviceAttribute("UlBandwidth", UintegerValue(100));

            // Install eNB device
            NetDeviceContainer enbDev = lteHelper->InstallEnbDevice(enbNode);
            enbDevices.Add(enbDev);

            // Initialize KPI tracking
            uint16_t cellId = cellIdCounter++;
            g_cellKpis[cellId].cellId = cellId;
            g_cellKpis[cellId].cellName = cellName;
            g_cellKpis[cellId].prbTotal = 100;
            cellNameToId[cellName] = cellId;

            // Create UEs for this cell
            if (initialUsers > 0) {
                NodeContainer cellUes;
                cellUes.Create(initialUsers);
                ueNodes.Add(cellUes);

                // Distribute UEs around the cell (within coverage radius)
                MobilityHelper ueMobility;
                Ptr<UniformDiscPositionAllocator> uePos = CreateObject<UniformDiscPositionAllocator>();
                uePos->SetX(siteLon);
                uePos->SetY(siteLat);
                uePos->SetRho(400.0);  // 400m radius
                ueMobility.SetPositionAllocator(uePos);
                ueMobility.SetMobilityModel("ns3::ConstantPositionMobilityModel");
                ueMobility.Install(cellUes);

                // Install UE devices and attach to this eNB
                NetDeviceContainer cellUeDevs = lteHelper->InstallUeDevice(cellUes);
                ueDevices.Add(cellUeDevs);
                lteHelper->Attach(cellUeDevs, enbDev.Get(0));

                // Set initial user count
                g_cellKpis[cellId].userCount = initialUsers;
            }

            NS_LOG_INFO("Created cell " << cellName << " (ID=" << cellId << ") with "
                        << initialUsers << " users, band=" << band << "MHz, tilt=" << tilt);
        }
    }

    // ========================================================================
    // Install Internet Stack on UEs
    // ========================================================================
    InternetStackHelper internet;
    internet.Install(ueNodes);

    Ipv4InterfaceContainer ueIpIfaces;
    ueIpIfaces = epcHelper->AssignUeIpv4Address(ueDevices);

    // Set default gateway for UEs
    Ipv4StaticRoutingHelper routingHelper;
    for (uint32_t u = 0; u < ueNodes.GetN(); u++) {
        Ptr<Node> ue = ueNodes.Get(u);
        Ptr<Ipv4StaticRouting> ueStaticRouting = routingHelper.GetStaticRouting(ue->GetObject<Ipv4>());
        ueStaticRouting->SetDefaultRoute(epcHelper->GetUeDefaultGatewayAddress(), 1);
    }

    // ========================================================================
    // Install Traffic Applications (DL)
    // ========================================================================
    uint16_t dlPort = 1234;
    ApplicationContainer serverApps;
    ApplicationContainer clientApps;

    Ptr<Node> remoteHost = epcHelper->GetPgwNode();  // Simplified: use PGW as server

    for (uint32_t u = 0; u < ueNodes.GetN(); u++) {
        // Server (sink) on each UE
        PacketSinkHelper dlPacketSinkHelper("ns3::UdpSocketFactory",
                                             InetSocketAddress(Ipv4Address::GetAny(), dlPort));
        serverApps.Add(dlPacketSinkHelper.Install(ueNodes.Get(u)));

        // Client (source) on PGW -> UE
        UdpClientHelper dlClient(ueIpIfaces.GetAddress(u), dlPort);
        dlClient.SetAttribute("Interval", TimeValue(MilliSeconds(20)));  // 50 pps
        dlClient.SetAttribute("MaxPackets", UintegerValue(100000));
        dlClient.SetAttribute("PacketSize", UintegerValue(1024));  // 1KB packets
        clientApps.Add(dlClient.Install(remoteHost));
    }

    serverApps.Start(Seconds(0.5));
    clientApps.Start(Seconds(1.0));

    // ========================================================================
    // Schedule Actions (if specified in config)
    // ========================================================================
    if (config.contains("action") && !config["action"].is_null()) {
        auto action = config["action"];
        std::string actionType = action["type"];
        std::string targetCell = action["cell_name"];
        double actionTime = action.value("time_s", 5.0);

        if (actionType == "tilt") {
            double newTilt = action["params"]["new_tilt"];
            // Find the target eNB index
            auto it = cellNameToId.find(targetCell);
            if (it != cellNameToId.end()) {
                uint16_t idx = it->second - 1;  // 0-indexed
                if (idx < enbDevices.GetN()) {
                    Ptr<LteEnbNetDevice> enbDev = enbDevices.Get(idx)->GetObject<LteEnbNetDevice>();
                    Simulator::Schedule(Seconds(actionTime), &ActionTilt, enbDev, newTilt);
                    NS_LOG_INFO("Scheduled tilt action on " << targetCell << " at t=" << actionTime);
                }
            }
        } else if (actionType == "power") {
            double newPower = action["params"]["new_power_dbm"];
            auto it = cellNameToId.find(targetCell);
            if (it != cellNameToId.end()) {
                uint16_t idx = it->second - 1;
                if (idx < enbDevices.GetN()) {
                    Ptr<LteEnbNetDevice> enbDev = enbDevices.Get(idx)->GetObject<LteEnbNetDevice>();
                    Simulator::Schedule(Seconds(actionTime), &ActionPower, enbDev, newPower);
                    NS_LOG_INFO("Scheduled power action on " << targetCell << " at t=" << actionTime);
                }
            }
        }
        // Add more action types as needed (add_carrier, redistribute, new_site)
    }

    // ========================================================================
    // Connect Trace Sources
    // ========================================================================
    Config::Connect("/NodeList/*/DeviceList/*/$ns3::LteEnbNetDevice/LteEnbRrc/ConnectionEstablished",
                    MakeCallback(&NotifyConnectionEstablished));
    Config::Connect("/NodeList/*/DeviceList/*/$ns3::LteEnbNetDevice/LteEnbRrc/HandoverEndOk",
                    MakeCallback(&NotifyHandover));

    // ========================================================================
    // Enable FlowMonitor for detailed stats
    // ========================================================================
    FlowMonitorHelper flowHelper;
    Ptr<FlowMonitor> flowMonitor = flowHelper.InstallAll();

    // ========================================================================
    // Run Simulation
    // ========================================================================
    Simulator::Stop(Seconds(simulationTime));
    NS_LOG_INFO("Starting simulation for " << simulationTime << " seconds...");
    Simulator::Run();

    // ========================================================================
    // Collect Results
    // ========================================================================
    json results;
    results["simulation_time_s"] = simulationTime;
    results["cells"] = json::array();

    for (auto& [cellId, kpi] : g_cellKpis) {
        // Calculate final averages
        double finalCqi = 0.0;
        if (!kpi.cqiSamples.empty()) {
            for (auto c : kpi.cqiSamples) finalCqi += c;
            finalCqi /= kpi.cqiSamples.size();
        } else {
            finalCqi = kpi.avgCqi;
        }

        double finalSinr = 0.0;
        if (!kpi.sinrSamples.empty()) {
            for (auto s : kpi.sinrSamples) finalSinr += s;
            finalSinr /= kpi.sinrSamples.size();
        } else {
            finalSinr = kpi.avgSinrDb;
        }

        // PRB utilization
        double prbUtilization = (kpi.prbTotal > 0) ?
            (100.0 * kpi.prbUsed / (kpi.prbTotal * simulationTime * 1000)) : 0.0;
        prbUtilization = std::min(100.0, prbUtilization);

        json cellResult;
        cellResult["cell_id"] = cellId;
        cellResult["cell_name"] = kpi.cellName;
        cellResult["user_count"] = kpi.userCount;
        cellResult["avg_cqi"] = std::round(finalCqi * 100) / 100.0;
        cellResult["avg_sinr_db"] = std::round(finalSinr * 100) / 100.0;
        cellResult["throughput_kbps"] = std::round(kpi.totalThroughputKbps * 100) / 100.0;
        cellResult["prb_utilization_pct"] = std::round(prbUtilization * 100) / 100.0;
        cellResult["handover_in"] = kpi.handoverIn;
        cellResult["handover_out"] = kpi.handoverOut;

        // Derive health score (simplified)
        double healthScore = 100.0;
        if (prbUtilization > 80) healthScore -= 30;
        else if (prbUtilization > 60) healthScore -= 15;
        if (finalCqi < 7) healthScore -= 25;
        else if (finalCqi < 10) healthScore -= 10;
        cellResult["health_score"] = std::max(0.0, healthScore);

        // Derive issue type
        std::string issueType = "Normal";
        if (prbUtilization > 85 && finalCqi < 7) issueType = "Congestion";
        else if (prbUtilization > 85) issueType = "Capacity Issue";
        else if (finalCqi < 7) issueType = "Coverage Issue";
        cellResult["issue_type"] = issueType;

        results["cells"].push_back(cellResult);
    }

    // FlowMonitor stats
    flowMonitor->CheckForLostPackets();
    Ptr<Ipv4FlowClassifier> classifier = DynamicCast<Ipv4FlowClassifier>(flowHelper.GetClassifier());
    FlowMonitor::FlowStatsContainer stats = flowMonitor->GetFlowStats();

    double totalRxBytes = 0;
    double totalDelay = 0;
    uint32_t totalPackets = 0;
    for (auto& [flowId, flowStats] : stats) {
        totalRxBytes += flowStats.rxBytes;
        totalDelay += flowStats.delaySum.GetSeconds();
        totalPackets += flowStats.rxPackets;
    }

    results["aggregate"] = {
        {"total_throughput_mbps", (totalRxBytes * 8.0) / (simulationTime * 1e6)},
        {"avg_delay_ms", totalPackets > 0 ? (totalDelay / totalPackets * 1000) : 0},
        {"total_flows", stats.size()}
    };

    // ========================================================================
    // Write Results
    // ========================================================================
    std::ofstream outFile(outputFile);
    outFile << results.dump(2);
    outFile.close();

    NS_LOG_INFO("Results written to " << outputFile);

    Simulator::Destroy();
    return 0;
}
