// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import "abdk-libraries-solidity/ABDKMathQuad.sol";

/// @author Jason Payne (https://twitter.com/Neo42)
contract SchnoodleStaking is Initializable, ContextUpgradeable {
    address private _stakingToken;
    mapping(address => Stake[]) private _stakes;
    uint256 private _totalTokens;
    uint256 private _cumulativeTotal;
    uint256 private _lastBlockNumber;
    uint256 private _totalStakeWeight;

    struct Stake {
        uint256 amount;
        uint256 blockNumber;
        uint256 vestingBlocks;
        uint256 claimable;
    }

    function initialize(address stakingToken) public initializer {
        __Context_init();
        _stakingToken = stakingToken;
    }

    /// Stakes the specified amount of tokens for the sender, and adds the details to a stored stake object
    function addStake(uint256 amount, uint256 vestingBlocks) external {
        address msgSender = _msgSender();

        require(amount <= balanceOf(msgSender) - stakedBalanceOf(msgSender), "SchnoodleStaking: stake amount exceeds unstaked balance");
        require(amount > 0, "Stake must be nonzero");

        uint256 blockNumber = block.number;
        _stakes[msgSender].push(Stake(amount, blockNumber, vestingBlocks, 0));
        adjustStakedBalance(int256(amount));

        _updateTracking(int256(amount), _newCumulativeTotal(blockNumber), blockNumber, vestingBlocks);

        emit Staked(msgSender, amount, blockNumber);
    }

    /// Withdraws the specified amount of tokens from the sender's stake at the specified zero-based index
    function withdraw(uint256 index, uint256 amount) external {
        address msgSender = _msgSender();
        Stake[] memory stakes = _stakes[msgSender];
        Stake memory stake = stakes[index];
        require(stake.amount >= amount, "SchnoodleStaking: cannot withdraw more than staked");

        uint256 blockNumber = block.number;
        require(stake.blockNumber + stake.vestingBlocks < blockNumber, "SchnoodleStaking: cannot withdraw during vesting blocks");

        (uint256 netReward, uint256 grossReward, uint256 newCumulativeTotal) = _rewardInfo(stake, amount, blockNumber);

        _updateTracking(-int256(amount), newCumulativeTotal, blockNumber, stake.vestingBlocks);

        _stakes[msgSender][index].amount -= amount;
        adjustStakedBalance(-int256(amount));

        // Remove the stake if it is fully withdrawn by replacing it with the last stake in the array
        if (_stakes[msgSender][index].amount == 0) {
            _stakes[msgSender][index] = stakes[stakes.length - 1];
            _stakes[msgSender].pop();
        }

        stakingReward(netReward, grossReward);

        emit Withdrawn(msgSender, index, amount, netReward, grossReward);
    }

    function _rewardInfo(Stake memory stake, uint256 amount, uint256 blockNumber) private returns(uint256, uint256, uint256) {
        // Calculate the stake amount multiplied across the number of blocks since the start of the stake
        uint256 cumulativeAmount = amount * (blockNumber - stake.blockNumber);

        // Get the new cumulative total of all stakes as the current stored value is from the previous staking activity
        uint256 newCumulativeTotal = _newCumulativeTotal(blockNumber);

        uint256 grossReward;
        uint256 netReward;

        if (cumulativeAmount > 0 && _totalStakeWeight > 0) {
            uint256 vestingBlocksWeightedAverage = _totalStakeWeight / _totalTokens;

            // Calculate a reward multiplier based on a sigmoid curve defined by 1 ÷ (1 + e⁻ˣ) where x is the stake's vesting blocks delta from the weighted average
            bytes16 x = ABDKMathQuad.mul(
                ABDKMathQuad.div(
                    ABDKMathQuad.fromInt(-10), // Adjust to change the S-shape (higher value increases slope)
                    ABDKMathQuad.fromUInt(vestingBlocksWeightedAverage)
                ),
                ABDKMathQuad.sub(
                    ABDKMathQuad.fromUInt(stake.vestingBlocks),
                    ABDKMathQuad.fromUInt(vestingBlocksWeightedAverage)
                )
            );

            // Calculate the reward as a relative proportion of the cumulative total of all holders' stakes, adjusted by the multiplier
            uint256 accuracy = 1000;
            grossReward = balanceOf(stakingFund()) * cumulativeAmount / newCumulativeTotal;
            netReward = (_multitplier(accuracy, x) * grossReward) / accuracy;

            // The returned new cumulative total should not include the reward
            newCumulativeTotal -= cumulativeAmount;
        }

        return (netReward, grossReward, newCumulativeTotal);
    }

    function _multitplier(uint256 accuracy, bytes16 x) private pure returns(uint256) {
        bytes16 one = ABDKMathQuad.fromUInt(1);

        return ABDKMathQuad.toUInt(
            ABDKMathQuad.mul(
                ABDKMathQuad.fromUInt(accuracy),
                ABDKMathQuad.div(one, ABDKMathQuad.add(one, ABDKMathQuad.exp(x)))
            )
        );
    }

    function _reward(Stake memory stake, uint256 blockNumber) private returns(uint256) {
        (uint256 reward,,) = _rewardInfo(stake, stake.amount, blockNumber);
        return reward;
    }

    function _newCumulativeTotal(uint256 blockNumber) private view returns(uint256) {
        // Add the total of all stakes multiplied across all blocks since the previous calculation to the cumulative total
        return _cumulativeTotal + _totalTokens * (blockNumber - _lastBlockNumber);
    }

    function _updateTracking(int256 amountDelta, uint256 cumulativeTotal, uint256 blockNumber, uint256 vestingBlocks) private {
        _cumulativeTotal = cumulativeTotal;
        _lastBlockNumber = blockNumber;
        _totalTokens = uint256(int256(_totalTokens) + amountDelta);

        // Adjust the sum of products of staked tokens and vesting blocks to get a total weight - this is used to calculate the weighted average later
        _totalStakeWeight = uint256(int256(_totalStakeWeight) + amountDelta * int256(vestingBlocks));
    }

    function stakingSummary(address account) public returns(Stake[] memory) {
        Stake[] memory stakes = _stakes[account];
        uint256 blockNumber = block.number;

        for (uint256 i = 0; i < stakes.length; i++) {
            stakes[i].claimable = _reward(stakes[i], blockNumber);
        }

        return stakes;
    }

    // Calls to the Schnoodle proxy contract

    function stakingFund() private returns (address) {
        (bool success, bytes memory result) = _stakingToken.call(abi.encodeWithSignature("stakingFund()"));
        assert(success);
        return abi.decode(result, (address));
    }

    function balanceOf(address account) private returns(uint256) {
        (bool success, bytes memory result) = _stakingToken.call(abi.encodeWithSignature("balanceOf(address)", account));
        assert(success);
        return abi.decode(result, (uint256));
    }

    function stakedBalanceOf(address account) private returns(uint256) {
        (bool success, bytes memory result) = _stakingToken.call(abi.encodeWithSignature("stakedBalanceOf(address)", account));
        assert(success);
        return abi.decode(result, (uint256));
    }

    // Delegate calls to the Schnoodle proxy contract

    function adjustStakedBalance(int256 amount) private {
        (bool success, bytes memory result) = _stakingToken.delegatecall(abi.encodeWithSignature("adjustStakedBalance(int256)", int256(amount)));
        assert(success);
    }

    function stakingReward(uint256 netReward, uint256 grossReward) private {
        (bool success, bytes memory result) = _stakingToken.delegatecall(abi.encodeWithSignature("stakingReward(uint256,uint256)", netReward, grossReward));
        assert(success);
    }

    // Events

    event Staked(address indexed account, uint256 amount, uint256 blockNumber);

    event Withdrawn(address indexed account, uint256 index, uint256 amount, uint256 netReward, uint256 grossReward);

    uint256[50] private __gap;
}
