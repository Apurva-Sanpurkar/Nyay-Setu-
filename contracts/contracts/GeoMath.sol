// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title GeoMath
 * @notice Integer-only geodesy for on-chain geo-fencing.
 *
 * Coordinates are micro-degrees (degrees * 1e6) stored as int256. That keeps
 * ~11 cm resolution with no floating point, which the EVM does not have.
 *
 * Distance uses an equirectangular projection: accurate to well under 1% for
 * the few-kilometre radii a bail geo-fence uses, and it needs no trigonometry
 * beyond a cosine we approximate from a 10-degree lookup table. We compare
 * squared distances so there is never a square root.
 */
library GeoMath {
    int256 internal constant LAT_MAX = 90_000_000;
    int256 internal constant LNG_MAX = 180_000_000;
    uint256 internal constant METRES_PER_DEGREE = 111_320;
    uint256 internal constant SCALE = 1_000_000;

    error InvalidCoordinates(int256 lat, int256 lng);

    /// @notice Reverts unless the pair is a real point on Earth.
    function validate(int256 lat, int256 lng) internal pure {
        if (lat > LAT_MAX || lat < -LAT_MAX || lng > LNG_MAX || lng < -LNG_MAX) {
            revert InvalidCoordinates(lat, lng);
        }
    }

    /// @notice cos(latitude) scaled by 1e6, linearly interpolated per 10 degrees.
    function cosLatitude(int256 latMicro) internal pure returns (uint256) {
        uint256 absDeg = _abs(latMicro);
        if (absDeg >= uint256(LAT_MAX)) return 0;

        uint256[10] memory table = [
            uint256(1_000_000), // 0 deg
            984_808, // 10
            939_693, // 20
            866_025, // 30
            766_044, // 40
            642_788, // 50
            500_000, // 60
            342_020, // 70
            173_648, // 80
            0 // 90
        ];

        uint256 idx = absDeg / 10_000_000; // 0..8 because absDeg < 90e6
        uint256 lo = table[idx];
        uint256 hi = table[idx + 1];
        uint256 frac = absDeg % 10_000_000;
        return lo - ((lo - hi) * frac) / 10_000_000;
    }

    /// @notice Squared great-circle-ish distance in square metres.
    function distanceSquared(int256 lat1, int256 lng1, int256 lat2, int256 lng2)
        internal
        pure
        returns (uint256)
    {
        int256 dLat = lat2 - lat1;
        int256 dLng = lng2 - lng1;

        // Take the shorter way round the antimeridian.
        if (dLng > LNG_MAX) dLng -= 2 * LNG_MAX;
        if (dLng < -LNG_MAX) dLng += 2 * LNG_MAX;

        uint256 metresY = (_abs(dLat) * METRES_PER_DEGREE) / SCALE;
        uint256 cosMid = cosLatitude((lat1 + lat2) / 2);
        uint256 metresX = (_abs(dLng) * METRES_PER_DEGREE * cosMid) / SCALE / SCALE;

        return metresY * metresY + metresX * metresX;
    }

    /// @notice Distance in whole metres. Only for reporting; comparisons use the square.
    function distance(int256 lat1, int256 lng1, int256 lat2, int256 lng2)
        internal
        pure
        returns (uint256)
    {
        return _sqrt(distanceSquared(lat1, lng1, lat2, lng2));
    }

    /// @notice True when the point sits inside the circle. radius 0 means "no fence".
    function withinRadius(
        int256 centreLat,
        int256 centreLng,
        int256 lat,
        int256 lng,
        uint256 radiusMetres
    ) internal pure returns (bool) {
        if (radiusMetres == 0) return true;
        return distanceSquared(centreLat, centreLng, lat, lng) <= radiusMetres * radiusMetres;
    }

    function _abs(int256 x) private pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }

    /// @dev Babylonian method, adequate for the metre-scale values we feed it.
    function _sqrt(uint256 x) private pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
