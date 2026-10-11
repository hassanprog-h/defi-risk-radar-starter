// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface Token {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}
interface Vault is Token {
    function asset() external view returns (address);
    function previewRedeem(uint256) external view returns (uint256);
    function previewDeposit(uint256) external view returns (uint256);
    function convertToAssets(uint256) external view returns (uint256);
    function redeem(uint256, address, address) external returns (uint256);
    function deposit(uint256, address) external returns (uint256);
}
interface VaultV2 {
    function isAdapter(address) external view returns (bool);
    function forceDeallocatePenalty(address) external view returns (uint256);
    function forceDeallocate(address, bytes calldata, uint256, address) external returns (uint256);
}

/// @notice Hackathon permission and atomic migration demonstrator. Cannot deploy on mainnet.
/// @dev No arbitrary calls, swaps, recipient changes, upgrades or sweeping of assets.
contract ForkPolicyMigrator {
    struct ForceLeg { address adapter; bytes data; uint256 maxAssets; uint256 maxPenaltyWad; }
    ForceLeg[] private liquidityRoute;
    address public immutable owner;
    address public immutable executor;
    Vault public immutable source;
    Vault public immutable destination;
    Token public immutable asset;
    uint256 public immutable perMoveLimit;
    uint256 public immutable cumulativeLimit;
    uint256 public immutable expiresAt;
    uint256 public immutable cooldown;
    uint256 public immutable minimumOutputBps;
    uint256 public spent;
    uint256 public lastExecution;
    bool public revoked;
    bool private entered;
    event Migrated(uint256 shares, uint256 assets, uint256 destinationShares, uint256 totalSharesDebited);
    event Revoked();

    constructor(address _executor, Vault _source, Vault _destination, uint256 _perMoveLimit,
        uint256 _cumulativeLimit, uint256 _expiresAt, uint256 _cooldown, uint256 _minimumOutputBps, ForceLeg[] memory _route) {
        require(block.chainid == 31337, "FORK_ONLY");
        require(_executor != address(0) && address(_source) != address(_destination), "IDENTITY");
        require(_source.asset() == _destination.asset(), "ASSET");
        require(_perMoveLimit > 0 && _perMoveLimit <= _cumulativeLimit && _expiresAt > block.timestamp, "LIMITS");
        require(_minimumOutputBps >= 9900 && _minimumOutputBps <= 10000, "OUTPUT_FLOOR");
        owner = msg.sender; executor = _executor; source = _source; destination = _destination;
        asset = Token(_source.asset()); perMoveLimit = _perMoveLimit; cumulativeLimit = _cumulativeLimit;
        expiresAt = _expiresAt; cooldown = _cooldown; minimumOutputBps = _minimumOutputBps;
        require(_route.length <= 4, "ROUTE_BUDGET");
        for (uint256 i; i < _route.length; ++i) {
            require(_route[i].maxAssets > 0 && _route[i].maxPenaltyWad <= 1e14
                && VaultV2(address(_source)).isAdapter(_route[i].adapter), "ROUTE_POLICY");
            liquidityRoute.push(_route[i]);
        }
    }
    function revoke() external {
        require(msg.sender == owner, "OWNER"); revoked = true; emit Revoked();
    }
    function execute(uint256 shares, uint256 minAssets, uint256 minDestinationShares) external {
        require(!entered, "REENTRANCY"); entered = true;
        require(msg.sender == executor && !revoked && block.timestamp < expiresAt, "PERMISSION");
        require(shares > 0 && shares <= perMoveLimit && spent + shares <= cumulativeLimit, "LIMITS");
        require(lastExecution == 0 || block.timestamp >= lastExecution + cooldown, "COOLDOWN");
        require(source.asset() == address(asset) && destination.asset() == address(asset), "ASSET_CHANGED");
        uint256 expected = source.previewRedeem(shares);
        require(expected > 0 && minAssets > 0 && minDestinationShares > 0, "ZERO_OUTPUT");
        uint256 assetFloor = expected * minimumOutputBps / 10000;
        if (minAssets > assetFloor) assetFloor = minAssets;
        uint256 shareFloor = destination.previewDeposit(expected) * minimumOutputBps / 10000;
        if (minDestinationShares > shareFloor) shareFloor = minDestinationShares;
        uint256 beforeAssets = asset.balanceOf(address(this));
        uint256 beforeShares = destination.balanceOf(owner);
        uint256 beforeSource = source.balanceOf(address(this));
        uint256 beforeOwnerShares = source.balanceOf(owner);
        uint256 priorSpent = spent; lastExecution = block.timestamp;
        // Only immutable, approved protocol-specific routes, never arbitrary calls.
        for (uint256 i; i < liquidityRoute.length; ++i) {
            uint256 idle = asset.balanceOf(address(source));
            uint256 needed = source.previewRedeem(shares);
            if (idle >= needed) break;
            ForceLeg storage leg = liquidityRoute[i];
            require(VaultV2(address(source)).isAdapter(leg.adapter)
                && VaultV2(address(source)).forceDeallocatePenalty(leg.adapter) <= leg.maxPenaltyWad, "ROUTE_CHANGED");
            uint256 amount = needed - idle;
            if (amount > leg.maxAssets) amount = leg.maxAssets;
            VaultV2(address(source)).forceDeallocate(leg.adapter, leg.data, amount, owner);
        }
        // ERC-4626 delegated redemption spends the owner's share allowance directly.
        // Avoid an unnecessary intermediary share transfer and its possible receive gate.
        source.redeem(shares, address(this), owner);
        uint256 totalDebit = beforeOwnerShares - source.balanceOf(owner);
        require(totalDebit >= shares && totalDebit <= perMoveLimit && priorSpent + totalDebit <= cumulativeLimit, "TOTAL_SHARE_LIMIT");
        spent = priorSpent + totalDebit;
        uint256 received = asset.balanceOf(address(this)) - beforeAssets;
        require(received >= assetFloor, "MIN_ASSETS");
        safeToken(address(asset), abi.encodeCall(Token.approve, (address(destination), received)));
        destination.deposit(received, owner);
        uint256 issued = destination.balanceOf(owner) - beforeShares;
        require(issued >= shareFloor && destination.convertToAssets(issued) >= assetFloor, "MIN_SHARES");
        // Clear even a nonstandard token's non-decrementing allowance.
        safeToken(address(asset), abi.encodeCall(Token.approve, (address(destination), 0)));
        require(asset.balanceOf(address(this)) == beforeAssets && source.balanceOf(address(this)) == beforeSource
            && asset.allowance(address(this), address(destination)) == 0, "RESIDUAL_BALANCE");
        entered = false; emit Migrated(shares, received, issued, totalDebit);
    }
    function safeToken(address target, bytes memory data) private {
        (bool ok, bytes memory result) = target.call(data);
        require(ok && (result.length == 0 || result.length == 32 && abi.decode(result, (bool))), "TOKEN_CALL");
    }
}
