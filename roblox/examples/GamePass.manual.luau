-- Example: manual game pass reporting.
-- Not needed by default — with Config.TrackGamePasses = true the module listens to
-- MarketplaceService.PromptGamePassPurchaseFinished itself and verifies ownership.
-- Use this only if you set TrackGamePasses = false and want to report from your
-- own purchase-finished handler.

local MarketplaceService = game:GetService("MarketplaceService")
local ServerScriptService = game:GetService("ServerScriptService")
local Analytics = require(ServerScriptService:WaitForChild("RoadsterAnalytics"))

MarketplaceService.PromptGamePassPurchaseFinished:Connect(function(player, gamePassId, wasPurchased)
	if not wasPurchased then
		return -- a closed/cancelled prompt is not a sale
	end
	-- ...your existing perk-granting code...
	Analytics.ReportGamePassPurchase(player, gamePassId) -- verifies ownership, never yields
end)
