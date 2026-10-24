-- RoadsterAnalyticsBootstrap (Script in ServerScriptService)
-- Starts player tracking, heartbeats and game pass reporting.
-- Developer product reporting is enabled separately inside your own
-- ProcessReceipt script with Analytics.WrapProcessReceipt (see README).

local ServerScriptService = game:GetService("ServerScriptService")
local Analytics = require(ServerScriptService:WaitForChild("RoadsterAnalytics"))

Analytics.Start()
