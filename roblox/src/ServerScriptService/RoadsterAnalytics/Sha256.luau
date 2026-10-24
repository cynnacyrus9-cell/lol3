-- Sha256 (ModuleScript, child of RoadsterAnalytics)
-- Pure-Luau SHA-256 and HMAC-SHA256. Only used when Config.SigningSecret is set
-- (HMAC request signing). The recommended Secrets-store mode does not need it.

local band, bxor, bnot, rrotate, rshift = bit32.band, bit32.bxor, bit32.bnot, bit32.rrotate, bit32.rshift

local K = {
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}

local Sha256 = {}

function Sha256.digest(message: string): string
	local len = #message
	local padLen = 64 - ((len + 9) % 64)
	if padLen == 64 then
		padLen = 0
	end
	local bitLen = len * 8
	local padded = message
		.. "\128"
		.. string.rep("\0", padLen)
		.. string.pack(">I4I4", math.floor(bitLen / 4294967296), bitLen % 4294967296)

	local h0, h1, h2, h3 = 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a
	local h4, h5, h6, h7 = 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
	local w = table.create(64, 0)

	for chunk = 1, #padded, 64 do
		for j = 0, 15 do
			w[j + 1] = string.unpack(">I4", padded, chunk + j * 4)
		end
		for j = 17, 64 do
			local v15, v2 = w[j - 15], w[j - 2]
			local s0 = bxor(rrotate(v15, 7), rrotate(v15, 18), rshift(v15, 3))
			local s1 = bxor(rrotate(v2, 17), rrotate(v2, 19), rshift(v2, 10))
			w[j] = band(w[j - 16] + s0 + w[j - 7] + s1, 0xffffffff)
		end

		local a, b, c, d, e, f, g, h = h0, h1, h2, h3, h4, h5, h6, h7
		for j = 1, 64 do
			local S1 = bxor(rrotate(e, 6), rrotate(e, 11), rrotate(e, 25))
			local ch = bxor(band(e, f), band(bnot(e), g))
			local temp1 = band(h + S1 + ch + K[j] + w[j], 0xffffffff)
			local S0 = bxor(rrotate(a, 2), rrotate(a, 13), rrotate(a, 22))
			local maj = bxor(band(a, b), band(a, c), band(b, c))
			local temp2 = band(S0 + maj, 0xffffffff)
			h, g, f, e = g, f, e, band(d + temp1, 0xffffffff)
			d, c, b, a = c, b, a, band(temp1 + temp2, 0xffffffff)
		end

		h0 = band(h0 + a, 0xffffffff)
		h1 = band(h1 + b, 0xffffffff)
		h2 = band(h2 + c, 0xffffffff)
		h3 = band(h3 + d, 0xffffffff)
		h4 = band(h4 + e, 0xffffffff)
		h5 = band(h5 + f, 0xffffffff)
		h6 = band(h6 + g, 0xffffffff)
		h7 = band(h7 + h, 0xffffffff)
	end

	return string.pack(">I4I4I4I4I4I4I4I4", h0, h1, h2, h3, h4, h5, h6, h7)
end

function Sha256.toHex(raw: string): string
	return (string.gsub(raw, ".", function(ch)
		return string.format("%02x", string.byte(ch))
	end))
end

function Sha256.hmac(key: string, message: string): string
	if #key > 64 then
		key = Sha256.digest(key)
	end
	key = key .. string.rep("\0", 64 - #key)
	local inner = table.create(64)
	local outer = table.create(64)
	for i = 1, 64 do
		local byte = string.byte(key, i)
		inner[i] = string.char(bxor(byte, 0x36))
		outer[i] = string.char(bxor(byte, 0x5c))
	end
	return Sha256.digest(table.concat(outer) .. Sha256.digest(table.concat(inner) .. message))
end

function Sha256.hmacHex(key: string, message: string): string
	return Sha256.toHex(Sha256.hmac(key, message))
end

return Sha256
