// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC777/ERC777Upgradeable.sol";

/// @author Jason Payne (https://twitter.com/Neo42)
/// @title A token staking superclass
/// Provides staking functionality to any token contract that inherits it
contract Stakeable is Initializable {
    ERC777Upgradeable private _stakingToken;
    address private _stakingFund;
    mapping(address => Stake[]) private _stakes;
    mapping(address => uint256) private _totals;
    uint256 private _total;
    uint256 private _cumulativeTotal;
    uint256 private _lastBlockNumber;

    uint256 private _stakingSupply;
    uint256 private _rewardPool;

    struct Stake {
        uint256 amount;
        uint256 blockNumber;
        uint256 claimable;
    }

    function __Stakeable_init(address stakingToken, address stakingFund) internal initializer {
        _stakingToken = ERC777Upgradeable(stakingToken);
        _stakingFund = stakingFund;
    }

    /// Stakes the specified amount of tokens for the sender, and adds the details to a stored stake object
    function addStake(uint256 amount) public {
        require(amount <= _stakingToken.balanceOf(msg.sender) - stakedBalanceOf(msg.sender), "Stakeable: stake amount exceeds unstaked balance");
        require(amount > 0, "Stakeable: stake amount must be nonzero");

        uint256 blockNumber = block.number;
        _stakes[msg.sender].push(Stake(amount, blockNumber, 0));
        _totals[msg.sender] += amount;

        _updateCumulativeTotal(blockNumber);
        _total += amount;

        emit Staked(msg.sender, amount, blockNumber);
    }

    /// Withdraws the specified amount of tokens from the sender's stake at the specified zero-based index
    function withdrawStake(uint256 index, uint256 amount) public virtual returns(uint256) {
        Stake[] memory stakes = _stakes[msg.sender];
        Stake memory stake = stakes[index];
        require(stake.amount >= amount, "Stakeable: cannot withdraw more than you have staked");

        uint256 blockNumber = block.number;

        // Calculate the stake amount multiplied across the number of block since the start of the stake
        uint256 cumulativeAmount = amount * (blockNumber - stake.blockNumber);

        _updateCumulativeTotal(blockNumber);

        // Calculate the reward as a relative proportion of the cumulative total of all holders' stakes
        uint256 reward = _stakingToken.balanceOf(_stakingFund) * cumulativeAmount / _cumulativeTotal;

        _cumulativeTotal -= cumulativeAmount;
        _total -= amount;

        _stakes[msg.sender][index].amount -= amount;
        _totals[msg.sender] -= amount;

        if (_stakes[msg.sender][index].amount == 0) {
            _stakes[msg.sender][index] = stakes[stakes.length - 1];
            _stakes[msg.sender].pop();
        }

        return reward;
    }

    function _updateCumulativeTotal(uint256 blockNumber) private {
        // Update the cumulative total of all blocks since the previous such calculation
        _cumulativeTotal += _total * (blockNumber - _lastBlockNumber);
        _lastBlockNumber = blockNumber;
    }

    function stakedBalanceOf(address account) public view returns(uint256) {
        return _totals[account];
    }

    function stakingSummary() public view returns(Stake[] memory) {
        return _stakes[msg.sender];
    }

    event Staked(address indexed user, uint256 amount, uint256 blockNumber);

    event Withdrawn(address indexed user, uint256 index, uint256 amount, uint256 reward);
}
