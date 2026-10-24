-- Example: adding Roadster Life Analytics to an EXISTING ProcessReceipt script.
-- Only two lines change. Your handler, grants and DataStore logic stay as they are.

local MarketplaceService = game:GetService("MarketplaceService")
local ServerScriptService = game:GetService("ServerScriptService")

-- (1) ADD: load the analytics module
local Analytics = require(ServerScriptService:WaitForChild("RoadsterAnalytics"))

local productHandlers = {
	-- [123456789] = function(receiptInfo, player) ...grant... return true end,
}

-- Your existing handler (unchanged).
local function processReceipt(receiptInfo)
	local player = game:GetService("Players"):GetPlayerByUserId(receiptInfo.PlayerId)
	if not player then
		return Enum.ProductPurchaseDecision.NotProcessedYet
	end
	local handler = productHandlers[receiptInfo.ProductId]
	local ok, granted = pcall(handler, receiptInfo, player)
	if not ok or not granted then
		return Enum.ProductPurchaseDecision.NotProcessedYet
	end
	-- ...save the receipt / grant as you already do...
	return Enum.ProductPurchaseDecision.PurchaseGranted
end

-- (2) CHANGE: was `MarketplaceService.ProcessReceipt = processReceipt`
MarketplaceService.ProcessReceipt = Analytics.WrapProcessReceipt(processReceipt)

--[[
	Alternative if you prefer not to wrap: call the reporter yourself right
	before returning PurchaseGranted (never before the item is granted):

		Analytics.ReportDeveloperProductPurchase(receiptInfo)
		return Enum.ProductPurchaseDecision.PurchaseGranted
]]
