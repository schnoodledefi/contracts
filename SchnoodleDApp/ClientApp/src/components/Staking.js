import React, { Component } from 'react';
import SchnoodleV1 from "../contracts/SchnoodleV1.json";
import SchnoodleV7 from "../contracts/SchnoodleV7.json";
import SchnoodleStaking from "../contracts/SchnoodleStakingV1.json";
import getWeb3 from "../getWeb3";
import debounce from 'lodash.debounce';
const bigInt = require("big-integer");
const { Duration } = require("luxon");
const humanizeDuration = require("humanize-duration");

export class Staking extends Component {
  static displayName = Staking.name;

  constructor(props) {
    super(props);

    this.state = {
      success: false,
      message: null,
      web3: null,
      schnoodle: null,
      schnoodleStaking: null,
      selectedAddress: null,
      getInfoIntervalId: 0,
      decimals: null,
      stakingFundBalance: 0,
      blockNumber: 0,
      averageBlockTime: 0,
      operativeFeeRate: 0,
      donationRate: 0,
      stakingRate: 0,
      sellQuota: { 'blockMetric': 0, 'amount': 0 },
      balance: 0,
      amountToStake: 0,
      vestingBlocks: 1,
      vestingBlocksMax: 0,
      unbondingBlocks: 1,
      unbondingBlocksMax: 0,
      vestForecastReward: 0,
      apy: 0,
      lockedBalance: 0,
      unbondingBalance: 0,
      stakeableAmount: 0,
      stakingSummary: [],
      unbondingSummary: [],
      withdrawAmounts: []
    };

    this.stakeAll = this.stakeAll.bind(this);
    this.addStake = this.addStake.bind(this);
    this.resetReflectTracker = this.resetReflectTracker.bind(this);
    this.updateAmountToStake = this.updateAmountToStake.bind(this);
    this.updateVestingBlocks = this.updateVestingBlocks.bind(this);
    this.updateUnbondingBlocks = this.updateUnbondingBlocks.bind(this);

    this.updateForecastReward = debounce(this.updateForecastReward, 250);
  }

  async componentDidMount() {
    try {
      const web3 = await getWeb3();

      const schnoodleDeployedNetwork = SchnoodleV1.networks[await web3.eth.net.getId()];
      const schnoodle = new web3.eth.Contract(SchnoodleV7.abi, schnoodleDeployedNetwork && schnoodleDeployedNetwork.address);
      const schnoodleStakingDeployedNetwork = SchnoodleStaking.networks[await web3.eth.net.getId()];
      const schnoodleStaking = new web3.eth.Contract(SchnoodleStaking.abi, schnoodleStakingDeployedNetwork && schnoodleStakingDeployedNetwork.address);

      this.setState({ web3, schnoodle, schnoodleStaking, selectedAddress: web3.currentProvider.selectedAddress }, async () => {
        await this.getInfo();
        const getInfoIntervalId = setInterval(async () => await this.getInfo(), 10000);
        this.setState({ getInfoIntervalId });
      });

      window.ethereum.on('accountsChanged', () => window.location.reload(true));
      window.ethereum.on('networkChanged', () => window.location.reload(true));
    } catch (err) {
      alert(`Failed to load web3, accounts, or contract. Check console for details.`);
      console.error(err);
    }
  }

  componentWillUnmount() {
    clearInterval(this.state.getInfoIntervalId);
    this.updateForecastReward.cancel();
  }

  async getInfo() {
    const { web3, schnoodle, schnoodleStaking, selectedAddress } = this.state;

    const decimals = await schnoodle.methods.decimals().call();
    const blockNumber = await web3.eth.getBlockNumber();

    let averageBlockTime;
    if (blockNumber > 0) {
      const blocksDenominator = Math.min(500, blockNumber);
      averageBlockTime = ((await web3.eth.getBlock(blockNumber)).timestamp - (await web3.eth.getBlock(blockNumber - blocksDenominator)).timestamp) / blocksDenominator;
    }

    this.setState({ decimals, blockNumber, averageBlockTime }, async () => {
      const operativeFeeRate = await schnoodle.methods.getOperativeFeeRate().call();
      const { 1: donationRate } = await schnoodle.methods.eleemosynary().call();
      const stakingRate = await schnoodle.methods.stakingRate().call();
      const sellQuota = await schnoodle.methods.sellQuota().call();
      const stakingFundBalance = bigInt(await schnoodle.methods.balanceOf(await schnoodle.methods.stakingFund().call()).call());

      const balance = bigInt(await schnoodle.methods.balanceOf(selectedAddress).call());
      const lockedBalance = bigInt(await schnoodleStaking.methods.lockedBalanceOf(selectedAddress).call());
      const unbondingBalance = bigInt(await schnoodleStaking.methods.unbondingBalanceOf(selectedAddress).call());
      const stakeableAmount = balance.subtract(lockedBalance);
      const vestingBlocksMax = this.blocksPerDuration({ years: 1 });
      const unbondingBlocksMax = this.blocksPerDuration({ years: 1 });

      // Fetch the staking summary while also calculating the APY for each stake
      const stakingSummary = await Promise.all([].concat(await schnoodleStaking.methods.stakingSummary(selectedAddress).call()).sort((a, b) => a.stake.blockNumber > b.stake.blockNumber ? 1 : -1).map(async (stakeReward, i) => {
        const apy = this.calculateApy(stakeReward.stake.amount, await schnoodleStaking.methods.reward(selectedAddress, i, await this.blockNumberAfterOneYear()).call())
        return { stake: bigInt(stakeReward.stake), reward: bigInt(stakeReward.reward), apy: apy };
      }));

      const unbondingSummary = [].concat(await schnoodleStaking.methods.unbondingSummary(selectedAddress).call()).sort((a, b) => a.expiryBlock > b.expiryBlock ? 1 : -1);

      let withdrawAmounts = [];
      for (let i = 0; i < stakingSummary.length; i++) {
        const withdrawAmount = this.state.withdrawAmounts[i];
        withdrawAmounts[i] = this.state.withdrawAmounts[i] === undefined ? this.scaleDownUnits(stakingSummary[i].stake.amount) : withdrawAmount;
      }

      this.setState({
        stakingFundBalance,
        operativeFeeRate,
        donationRate,
        stakingRate,
        sellQuota,
        balance,
        vestingBlocksMax,
        unbondingBlocksMax,
        lockedBalance,
        unbondingBalance,
        stakeableAmount,
        stakingSummary,
        unbondingSummary,
        withdrawAmounts
      });
    });
  }

  scaleDownUnits(amount) {
    return bigInt(amount).divide(10 ** this.state.decimals).toJSNumber();
  }

  scaleUpUnits(amount) {
    return bigInt(amount).multiply(10 ** this.state.decimals);
  }

  async handleResponse(response) {
    if (response.status) {
      this.setState({ success: true, message: response.transactionHash });
    }

    await this.getInfo();
  }

  handleError(err) {
    console.error(err);
    let message = err.message;

    if (err.message.includes('[ethjs-query] while formatting outputs from RPC')) {
      message = JSON.parse(err.message.match('(?<=\')(?:\\\\.|[^\'\\\\])*(?=\')')).value.data.message;
    }

    this.setState({ success: false, message });
    alert(message);
  }

  async addStake() {
    try {
      const { schnoodleStaking, selectedAddress, amountToStake, vestingBlocks, unbondingBlocks, stakeableAmount } = this.state;

      const amountToStakeValue = this.preventDust(amountToStake, stakeableAmount);
      const response = await schnoodleStaking.methods.addStake(amountToStakeValue.toString(), vestingBlocks, unbondingBlocks).send({ from: selectedAddress });
      this.handleResponse(response);
    } catch (err) {
      await this.handleError(err);
    }
  }

  async withdrawStake(i) {
    try {
      const { schnoodleStaking, selectedAddress, withdrawAmounts, stakingSummary } = this.state;

      const stakeReward = stakingSummary[i];
      const amountToWithdraw = this.preventDust(withdrawAmounts[i], stakeReward.stake.amount);
      const response = await schnoodleStaking.methods.withdraw(stakeReward.stake.id, amountToWithdraw.toString()).send({ from: selectedAddress });
      this.handleResponse(response);
    } catch (err) {
      await this.handleError(err);
    }
  }

  preventDust(userAmount, maxAmount) {
    return userAmount === this.scaleDownUnits(maxAmount) ? maxAmount : this.scaleUpUnits(userAmount);
  }

  async resetReflectTracker() {
    try {
      const { schnoodle, selectedAddress } = this.state;
      const response = await schnoodle.methods.resetReflectTracker().send({ from: selectedAddress });
      this.handleResponse(response);
    } catch (err) {
      await this.handleError(err);
    }
  }

  async stakeAll() {
    this.setState({ amountToStake: this.scaleDownUnits(this.state.stakeableAmount) }, async () => await this.updateForecastReward());
  }

  updateWithdrawAmount(index, e) {
    const value = Number(e.target.value);
    if (!Number.isInteger(value)) return;
    let withdrawAmounts = this.state.withdrawAmounts;
    withdrawAmounts[index] = Math.min(value, this.scaleDownUnits(this.state.stakingSummary[index].stake.amount));
    this.setState({ withdrawAmounts });
  }

  async updateAmountToStake(e) {
    const value = Number(e.target.value);
    if (!Number.isInteger(value)) return;
    this.setState({ amountToStake: Math.min(value, this.scaleDownUnits(this.state.stakeableAmount)) }, async () => await this.updateForecastReward());
  }

  async updateVestingBlocks(e) {
    const value = Number(e.target.value);
    if (!Number.isInteger(value)) return;
    this.setState({ vestingBlocks: Math.min(value, this.state.vestingBlocksMax) }, async () => await this.updateForecastReward());
  }

  async updateUnbondingBlocks(e) {
    const value = Number(e.target.value);
    if (!Number.isInteger(value)) return;
    this.setState({ unbondingBlocks: Math.min(value, this.state.unbondingBlocksMax) }, async () => await this.updateForecastReward());
  }

  async updateForecastReward() {
    const { schnoodleStaking, amountToStake, vestingBlocks, unbondingBlocks, blockNumber } = this.state;

    if (amountToStake === 0 || vestingBlocks === 0 || unbondingBlocks === 0) {
      this.setState({ vestForecastReward: 0, apy: 0 });
      return;
    }

    const amountToStakeValue = this.scaleUpUnits(amountToStake);
    const vestForecastReward = await newStakeForecastReward(blockNumber + vestingBlocks);
    const yearForecastReward = await newStakeForecastReward(await this.blockNumberAfterOneYear());
    const apy = this.calculateApy(amountToStakeValue, yearForecastReward);
    this.setState({ vestForecastReward, apy });

    async function newStakeForecastReward(rewardBlock) {
      if (rewardBlock === 0) return 0;
      return await schnoodleStaking.methods.reward(amountToStakeValue.toString(), vestingBlocks.toString(), unbondingBlocks, rewardBlock).call();
    }
  }

  blocksPerDuration(duration) {
    const { averageBlockTime } = this.state;
    return averageBlockTime === 0 ? 0 : Math.floor(Duration.fromObject(duration).as('seconds') / averageBlockTime);
  }

  blocksDurationText(blocks) {
    return 'Approximately ' + humanizeDuration(Duration.fromObject({ seconds: blocks * this.state.averageBlockTime }), { largest: 2, round: true });
  }

  blockNumberAfterOneYear() {
    const { blockNumber } = this.state;
    return blockNumber + this.blocksPerDuration({ years: 1 });
  }

  calculateApy(amount, reward) {
    return reward === '0' ? 0 : Math.floor(reward / amount * 100);
  }

  renderStakingSummaryTable(stakingSummary) {
    return (
      <div role="table" aria-label="Staking Summary" class="border-secondary border-4 rounded-2xl text-accent-content">
        <div role="row-group" class="column-header-group">
          <div role="row">
            <span role="column-header" class="narrower">Block<br/>Number</span>
            <span role="column-header">Staked<br/>Amount</span>
            <span role="column-header" class="narrow" >Blocks<br/>Pending</span>
            <span role="column-header">Unbonding<br/>Blocks</span>
            <span role="column-header" class="narrow">Estimated<br/>APY</span>
            <span role="column-header" class="wider">Withdraw</span>
            <span role="column-header" class="wide">Claimable<br/>Reward</span>
          </div>
        </div> 
        <div role="row-group" class="text-secondary">
          {stakingSummary.map((stakeReward, i) => {
            const amount = this.scaleDownUnits(stakeReward.stake.amount);
            const blocksPending = Math.max(0, parseInt(stakeReward.stake.blockNumber) + parseInt(stakeReward.stake.vestingBlocks) - this.state.blockNumber);
            return (
              <div role="row" key={stakeReward.stake.blockNumber}>
                <span role="cell" data-header="Block Number:" class="border-l-0 narrower">{stakeReward.stake.blockNumber}</span>
                <span role="cell" data-header="Staked Amount:">{amount.toLocaleString()}</span>
                <span role="cell" data-header="Blocks Pending:" class="narrow" title={this.blocksDurationText(blocksPending)}>{blocksPending}</span>
                <span role="cell" data-header="Unbonding Blocks:"title={this.blocksDurationText(stakeReward.stake.unbondingBlocks)}>{stakeReward.stake.unbondingBlocks}</span>
                <span role="cell" data-header="Estimated APY:" class="narrow" >{stakeReward.apy} %</span>
                <span role="cell" class="wider">
                  <form>
                    <fieldset disabled={blocksPending > 0}>
                      <div class="relative">
                        <div class="form-control">
                          <input type="number" min="1" max={amount} value={this.state.withdrawAmounts[i] || ''} onChange={this.updateWithdrawAmount.bind(this, i)} class="withdrawinput"/>
                          <button type="button" class="text-base xl:text-xl absolute top-0 right-0 rounded-l-none btn btn-secondary text-base-300 px-2 lg:px-3 xl:px-8" disabled={this.state.withdrawAmounts[i] < 1 || this.state.withdrawAmounts[i] > amount} onClick={this.withdrawStake.bind(this, i)}><span class="">Withdraw</span></button>
                        </div>
                      </div>
                    </fieldset>
                  </form>
                </span>
                <span role="cell" data-header="Claimable Reward:" class="wide">{this.scaleDownUnits(stakeReward.reward).toLocaleString()}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  renderUnbondingSummaryTable(unbondingSummary) {
    return (
      <div role="table" aria-label="Staking Summary" class="border-secondary border-4 rounded-2xl text-accent-content">
        <div role="row-group" class="column-header-group">
          <div role="row">
            <span role="column-header" class="">Amount</span>
            <span role="column-header" class="" >Blocks Pending</span>
            <span role="column-header">Time Remaining</span>
          </div> 
        </div>
        <div role="row-group" class="text-secondary">
          {unbondingSummary.map((unbond, i) => {
            const amount = this.scaleDownUnits(unbond.amount);
            const blocksPending = parseInt(unbond.expiryBlock) - this.state.blockNumber;
            return blocksPending > 0 && (
              <div role="row" key={unbond.expiryBlock}>
                <span role="cell" data-header="Amount:" class="">{amount.toLocaleString()}</span>
                <span role="cell" data-header="Blocks Pending:" class="">{blocksPending}</span>
                <span role="cell" data-header="Time Remaining:" class="">{this.blocksDurationText(blocksPending)}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  render() {
    const balance = this.scaleDownUnits(this.state.balance);
    const lockedBalance = this.scaleDownUnits(this.state.lockedBalance);
    const unbondingBalance = this.scaleDownUnits(this.state.unbondingBalance);
    const stakeableAmount = this.scaleDownUnits(this.state.stakeableAmount);

    const token = 'SNOOD';
    const stakeTokens = `Stake ${token} tokens.`;
    const earnTokens = `Earn ${token} tokens.`;

    if (!this.state.web3) {
      return (
        <div class="overflow-hidden antialiased font-roboto mx-4">  
          <div class="h-noheader md:flex">
            <div class="flex items-center justify-center w-full">
              <div class="px-4">
              <img class="object-cover w-1/2 my-10" src="../../assets/img/svg/schnoodle-logo-white.svg" alt="Schnoodle logo" />
                <div class="maintitles">SCHNOODLE X</div>
                <div class="w-16 h-1 my-3 bg-secondary md:my-6"></div>
                <p class="text-4xl font-light leading-normal text-accent md:text-5xl loading">Loading<span>.</span><span>.</span><span>.</span></p>
                <div class="px-4 mt-4 fakebutton">&nbsp;</div>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div class="m-auto px-4 max-w-screen-2xl">
        <div class="h-noheader overflow-hidden bg-neutral-focus mx-2 md:m-auto font-roboto">
          <div class="text-center px-1 md:px-4 ">
            <div class="text-base-200 w-full ">
              <h1 class="mt-10 mb-2 maintitles leading-tight text-center md:text-left uppercase">Staking</h1>
              <p class="my-2 text-2xl md:text-3xl leading-tight titlefont w-2/3 md:w-full m-auto md:mx-0 textfade from-green-400 to-purple-500">
                <span class="block md:hidden text-center">{stakeTokens}<br />{earnTokens}</span>
                <span class="hidden md:block text-left">{stakeTokens} {earnTokens}</span>
              </p>
              <div class="stats topstats">
                <div class="stat">
                  <div class="stat-title">Block Number</div>
                  <div class="stat-value greenfade">{this.state.blockNumber}</div>
                  <div class="stat-desc">&nbsp;</div>
                </div>
                <div class="stat">
                  <div class="stat-title">Sell Quota</div>
                  <div class="stat-value greenfade">{this.scaleDownUnits(this.state.sellQuota.amount).toLocaleString()}</div>
                  <div class="stat-desc">{token} since {new Date(this.state.sellQuota.blockMetric * 1000).toLocaleString()}</div>
                </div>
                <div class="stat">
                  <div class="stat-title">Staking Fund Balance</div>
                  <div class="stat-value greenfade">{this.scaleDownUnits(this.state.stakingFundBalance).toLocaleString()}</div>
                  <div class="stat-desc">{token}</div>
                </div>
              </div>

              <div class="stats topstats">
                <div class="stat">
                  <div class="stat-title">Operative Fee Rate</div>
                  <div class="stat-value greenfade">{this.state.operativeFeeRate / 10}</div>
                  <div class="stat-desc">%</div>
                </div>
                <div class="stat">
                  <div class="stat-title">Eleemosynary Donation Rate</div>
                  <div class="stat-value greenfade">{this.state.donationRate / 10}</div>
                  <div class="stat-desc">%</div>
                </div>
                <div class="stat">
                  <div class="stat-title">Staking Rate</div>
                  <div class="stat-value greenfade">{this.state.stakingRate / 10}</div>
                  <div class="stat-desc">%</div>
                </div>
              </div>

              <div class="card shadow-sm border-purple-500 border-4 rounded-2xl text-accent-content mt-5 mb-5 container-lg">
                <div class="card-body my-6 md:my-10 rounded-4xl">
                  <h2 class="card-title headingfont text-purple-500"><span class="purplefade">Your {token} Tokens</span></h2>
                  <div class="shadow-sm bottomstats stats">
                    <div class="stat border-t-0">
                      <div class="stat-title">Total Balance</div>
                      <div class="stat-value purplefade">{balance.toLocaleString()}</div>
                      <div class="stat-desc">{token}</div>
                    </div>
                    <div class="stat">
                      <div class="stat-title">Locked Balance</div>
                      <div class="stat-value purplefade">{lockedBalance.toLocaleString()}</div>
                      <div class="stat-desc">{token}{unbondingBalance > 0 && (<span class="opacity-60 text-xs"><br />{unbondingBalance.toLocaleString()} unbonding</span>)}</div>
                    </div>
                    <div class="stat">
                      <div class="stat-title">Stakeable Amount</div>
                      <div class="stat-value purplefade">{stakeableAmount.toLocaleString()}</div>
                      <div class="stat-desc">{token}</div>
                    </div>
                  </div>
                  <div class="divider mt-10">
                    <h3 class="staketitle text-2xl md:text-3xl leading-tight">Add Stake</h3>
                  </div>

                  <div class="card-actions text-center mx-auto w-full">
                    <form class=" justify-center fullhalfwidth mx-auto mt-5">
                      <fieldset disabled={stakeableAmount === 0}>
                        <div class="form-control">
                          <div>
                            <label class="label">
                              <span class="label-text">Amount</span>
                            </label> 
                            <div class="relative withbutton">
                              <input type="number" min="1" max={stakeableAmount} value={this.state.amountToStake || ''} onChange={this.updateAmountToStake} class="stakeinput" />
                              <button type="button" class="absolute top-0 right-0 rounded-l-none btn btn-accent opacity-80 bordered border-accent text-base-300 text-lg uppercase" onClick={this.stakeAll}>All</button>
                            </div>
                          </div>
                        </div>
                        <div class="mb-3 form-control nobutton">
                          <label class="label">
                            <span class="label-text">Vesting Blocks</span>
                          </label>
                          <input type="number" min="1" max={this.state.vestingBlocksMax} placeholder={'Max: ' + this.state.vestingBlocksMax} value={this.state.vestingBlocks || ''} onChange={this.updateVestingBlocks} class="stakeinput" />
                          <p class="approxLabel">{this.blocksDurationText(this.state.vestingBlocks)}</p>
                        </div>
                        <div class="mb-3 form-control nobutton">
                          <label class="label">
                            <span class="label-text">Unbonding Blocks</span>
                          </label>
                          <input type="number" min="1" max={this.state.unbondingBlocksMax} placeholder={'Max: ' + this.state.unbondingBlocksMax} value={this.state.unbondingBlocks || ''} onChange={this.updateUnbondingBlocks} class="stakeinput" />
                          <p class="approxLabel">{this.blocksDurationText(this.state.unbondingBlocks)}</p>
                        </div>
                        <div class="shadow-sm bottomstats stats ">
                          <div class="stat border-t-1 md:border-t-0 md:border-base-200">
                            <div class="stat-title">Vest Forecast Reward</div>
                            <div class="stat-value text-accent">{this.scaleDownUnits(this.state.vestForecastReward).toLocaleString()}</div>
                            <div class="stat-desc">{token}</div>
                          </div>
                          <div class="stat border-t-1 md:border-t-0 md:border-base-200">
                            <div class="stat-title">Estimated APY</div>
                            <div class="stat-value text-accent">{this.state.apy}</div>
                            <div class="stat-desc">%</div>
                          </div>
                        </div>
                        <div class="mb-3 form-control">
                          <button type="button" className='btn btn-accent mt-5 text-xl font-black' disabled={this.state.amountToStake < 1 || this.state.vestingBlocks < 1 || this.state.unbondingBlocks < 1 || this.state.amountToStake > stakeableAmount} onClick={this.addStake}>Stake</button>
                        </div>
                      </fieldset>
                    </form>
                  </div>
                </div>
              </div>

              {this.state.stakingSummary.length > 0 && (
                <div class="staketable">
                  <h3 class="mb-5 headingfont staketitle mt-10">Your Stakes</h3>
                  <div class="overflow-x-auto text-secondary my-5 ">
                    {this.renderStakingSummaryTable(this.state.stakingSummary)}
                  </div>
                </div>
              )}

              {this.state.unbondingSummary.length > 0 && this.state.unbondingSummary.some(u => parseInt(u.expiryBlock) - this.state.blockNumber > 0) && (
                <div class="staketable">
                  <h3 class="mb-5 headingfont staketitle mt-10">Unbonding</h3>
                  <div class="overflow-x-auto text-secondary my-5 ">
                    {this.renderUnbondingSummaryTable(this.state.unbondingSummary)}
                  </div>
                </div>
              )}

              <div class="my-5">
                <p style={{ color: this.state.success ? 'green' : 'red' }}>{this.state.message}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
