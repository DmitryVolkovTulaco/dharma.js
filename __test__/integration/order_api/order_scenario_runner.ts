// External
import * as ABIDecoder from "abi-decoder";
import * as compact from "lodash.compact";
import * as moment from "moment";
import * as Web3 from "web3";
import { BigNumber } from "../../../utils/bignumber";

// Wrappers
import {
    DebtKernelContract,
    DebtOrderDataWrapper,
    DummyTokenContract,
    RepaymentRouterContract,
    SimpleInterestTermsContractContract,
    TokenRegistryContract,
    TokenTransferProxyContract,
} from "../../../src/wrappers";

// APIs
import { AdaptersAPI, ContractsAPI, OrderAPI, SignerAPI } from "../../../src/apis";

// Scenarios
import {
    FillScenario,
    IssuanceCancellationScenario,
    OrderCancellationScenario,
    OrderGenerationScenario,
    UnpackTermsScenario,
} from "./scenarios/";

// Types
import { Adapter } from "../../../src/adapters";
import { DebtOrderData } from "../../../src/types";

// Utils
import { CollateralizedSimpleInterestLoanOrder } from "../../../src/adapters/collateralized_simple_interest_loan_adapter";
import { SimpleInterestLoanOrder } from "../../../src/adapters/simple_interest_loan_adapter";
import * as Units from "../../../utils/units";
import { Web3Utils } from "../../../utils/web3_utils";
import { ACCOUNTS } from "../../accounts";

const TX_DEFAULTS = { from: ACCOUNTS[0].address, gas: 4712388 };

export class OrderScenarioRunner {
    public web3Utils: Web3Utils;
    public debtKernel: DebtKernelContract;
    public repaymentRouter: RepaymentRouterContract;
    public tokenTransferProxy: TokenTransferProxyContract;
    public principalToken: DummyTokenContract;
    public termsContract: SimpleInterestTermsContractContract;
    public orderApi: OrderAPI;
    public contractsApi: ContractsAPI;
    public orderSigner: SignerAPI;
    public adaptersApi: AdaptersAPI;

    private currentSnapshotId: number;

    private readonly web3: Web3;

    constructor(web3: Web3) {
        this.web3Utils = new Web3Utils(web3);
        this.web3 = web3;

        this.testCheckOrderFilledScenario = this.testCheckOrderFilledScenario.bind(this);
        this.testFillScenario = this.testFillScenario.bind(this);
        this.testAssertFillable = this.testAssertFillable.bind(this);
        this.testAssertReadyToFill = this.testAssertReadyToFill.bind(this);
        this.testOrderCancelScenario = this.testOrderCancelScenario.bind(this);
        this.testIssuanceCancelScenario = this.testIssuanceCancelScenario.bind(this);
        this.testOrderGenerationScenario = this.testOrderGenerationScenario.bind(this);
        this.testUnpackTermsScenario = this.testUnpackTermsScenario.bind(this);

        this.saveSnapshotAsync = this.saveSnapshotAsync.bind(this);
        this.revertToSavedSnapshot = this.revertToSavedSnapshot.bind(this);
    }

    public testCheckOrderFilledScenario(scenario: FillScenario) {
        describe(scenario.description, () => {
            let debtOrderData: DebtOrderData;

            beforeAll(() => {
                ABIDecoder.addABI(this.debtKernel.abi);
            });

            afterAll(() => {
                ABIDecoder.removeABI(this.debtKernel.abi);
            });

            beforeEach(async () => {
                debtOrderData = await this.setUpFillScenario(scenario);
            });

            test("returns false if order has not been filled", async () => {
                expect(await this.orderApi.checkOrderFilledAsync(debtOrderData)).toEqual(false);
            });

            test("returns true if order has been filled", async () => {
                await this.orderApi.fillAsync(debtOrderData, {
                    from: scenario.filler,
                });

                expect(await this.orderApi.checkOrderFilledAsync(debtOrderData)).toEqual(true);
            });

            describe("when validating the loan order", () => {
                const validateMock = jest.fn();
                let originalValidate: (
                    loanOrder: SimpleInterestLoanOrder | CollateralizedSimpleInterestLoanOrder,
                ) => void;
                let adapter: Adapter;

                beforeAll(async () => {
                    adapter = await this.adaptersApi.getAdapterByTermsContractAddress(
                        debtOrderData.termsContract,
                    );

                    originalValidate = adapter.validateAsync;
                    // Mock the validate function, to count the number of times it was called,
                    // and to spy on the given arguments.
                    adapter.validateAsync = validateMock;
                });

                afterAll(() => {
                    // Replace the adapter's validate function.
                    adapter.validateAsync = validateMock;
                });

                test("it calls validate on the appropriate adapter once", async () => {
                    await this.orderApi.fillAsync(debtOrderData, {
                        from: scenario.filler,
                    });

                    expect(validateMock).toHaveBeenCalledTimes(1);
                });

                test("it calls validate with a loan order adapted from the debt order", async () => {
                    const loanOrder = await adapter.fromDebtOrder(debtOrderData);

                    await this.orderApi.fillAsync(debtOrderData, {
                        from: scenario.filler,
                    });

                    // Assert the expected input, which is a loan order.
                    expect(validateMock).toHaveBeenCalledWith(loanOrder);
                });
            });
        });
    }

    public testAssertReadyToFill(scenario: FillScenario) {
        describe(scenario.description, () => {
            let debtOrderData: DebtOrderData;

            beforeEach(async () => {
                debtOrderData = await this.setUpFillScenario(scenario);
            });

            if (scenario.successfullyFills) {
                test("does not throw", async () => {
                    await expect(
                        this.orderApi.assertReadyToFill(debtOrderData, {
                            from: scenario.filler,
                        }),
                    ).resolves.not.toThrow();
                });
            } else {
                test(`throws ${scenario.errorType} error`, async () => {
                    await expect(
                        this.orderApi.assertReadyToFill(debtOrderData, { from: scenario.filler }),
                    ).rejects.toThrow(scenario.errorMessage);
                });
            }
        });
    }

    public testAssertFillable(scenario: FillScenario) {
        describe(scenario.description, () => {
            let debtOrderData: DebtOrderData;

            beforeAll(() => {
                ABIDecoder.addABI(this.debtKernel.abi);
            });

            afterAll(() => {
                ABIDecoder.removeABI(this.debtKernel.abi);
            });

            beforeEach(async () => {
                debtOrderData = await this.setUpFillScenario(scenario);
            });

            if (scenario.successfullyFills) {
                test("does not throw", async () => {
                    await expect(
                        this.orderApi.assertFillableAsync(debtOrderData, {
                            from: scenario.filler,
                        }),
                    ).resolves.not.toThrow();
                });
            } else {
                test(`throws ${scenario.errorType} error`, async () => {
                    await expect(
                        this.orderApi.assertFillableAsync(debtOrderData, { from: scenario.filler }),
                    ).rejects.toThrow(scenario.errorMessage);
                });
            }
        });
    }

    public testFillScenario(scenario: FillScenario) {
        describe(scenario.description, () => {
            let debtOrderData: DebtOrderData;

            beforeAll(() => {
                ABIDecoder.addABI(this.debtKernel.abi);
            });

            afterAll(() => {
                ABIDecoder.removeABI(this.debtKernel.abi);
            });

            beforeEach(async () => {
                debtOrderData = await this.setUpFillScenario(scenario);
            });

            if (scenario.successfullyFills) {
                test("emits log indicating successful fill", async () => {
                    const txHash = await this.orderApi.fillAsync(debtOrderData, {
                        from: scenario.filler,
                    });

                    const receipt = await this.web3Utils.getTransactionReceiptAsync(txHash);

                    const [debtOrderFilledLog] = compact(ABIDecoder.decodeLogs(receipt.logs));

                    expect(debtOrderFilledLog.name).toBe("LogDebtOrderFilled");
                });
            } else {
                test(`throws ${scenario.errorType} error`, async () => {
                    await expect(
                        this.orderApi.fillAsync(debtOrderData, { from: scenario.filler }),
                    ).rejects.toThrow(scenario.errorMessage);
                });
            }
        });
    }

    public async testOrderCancelScenario(scenario: OrderCancellationScenario) {
        describe(scenario.description, () => {
            let debtOrderData: DebtOrderData;

            beforeAll(() => {
                ABIDecoder.addABI(this.debtKernel.abi);
            });

            afterAll(() => {
                ABIDecoder.removeABI(this.debtKernel.abi);
            });

            beforeEach(async () => {
                debtOrderData = scenario.generateDebtOrderData(
                    this.debtKernel,
                    this.repaymentRouter,
                    this.principalToken,
                );

                if (scenario.orderAlreadyCancelled) {
                    await this.orderApi.cancelOrderAsync(debtOrderData, {
                        from: debtOrderData.debtor,
                    });
                }

                if (scenario.issuanceAlreadyCancelled) {
                    const debtOrderDataWrapped = new DebtOrderDataWrapper(debtOrderData);
                    await this.orderApi.cancelIssuanceAsync(
                        debtOrderDataWrapped.getIssuanceCommitment(),
                        { from: debtOrderData.debtor },
                    );
                }
            });

            if (scenario.successfullyCancels) {
                test("emits log indicating successful fill", async () => {
                    const txHash = await this.orderApi.cancelOrderAsync(debtOrderData, {
                        from: scenario.canceller,
                    });

                    const receipt = await this.web3Utils.getTransactionReceiptAsync(txHash);

                    const [debtOrderCancelledLog] = compact(ABIDecoder.decodeLogs(receipt.logs));

                    expect(debtOrderCancelledLog.name).toBe("LogDebtOrderCancelled");
                });

                test("isCancelled returns false before cancel", async () => {
                    const isCancelled = await this.orderApi.isCancelled(debtOrderData);

                    expect(isCancelled).toEqual(false);
                });

                test("isCancelled returns true after cancel", async () => {
                    await this.orderApi.cancelOrderAsync(debtOrderData, {
                        from: scenario.canceller,
                    });

                    const isCancelled = await this.orderApi.isCancelled(debtOrderData);

                    expect(isCancelled).toEqual(true);
                });
            } else {
                test(`throws ${scenario.errorType} error`, async () => {
                    await expect(
                        this.orderApi.cancelOrderAsync(debtOrderData, { from: scenario.canceller }),
                    ).rejects.toThrow(scenario.errorMessage);
                });
            }
        });
    }

    public async testIssuanceCancelScenario(scenario: IssuanceCancellationScenario) {
        describe(scenario.description, () => {
            let debtOrderData: DebtOrderData;

            beforeAll(() => {
                ABIDecoder.addABI(this.debtKernel.abi);
            });

            afterAll(() => {
                ABIDecoder.removeABI(this.debtKernel.abi);
            });

            beforeEach(async () => {
                debtOrderData = scenario.generateDebtOrderData(
                    this.debtKernel,
                    this.repaymentRouter,
                    this.principalToken,
                );

                if (scenario.orderAlreadyCancelled) {
                    await this.orderApi.cancelOrderAsync(debtOrderData, {
                        from: debtOrderData.debtor,
                    });
                }

                if (scenario.issuanceAlreadyCancelled) {
                    const debtOrderDataWrapped = new DebtOrderDataWrapper(debtOrderData);
                    await this.orderApi.cancelIssuanceAsync(
                        debtOrderDataWrapped.getIssuanceCommitment(),
                        { from: debtOrderData.debtor },
                    );
                }
            });

            if (scenario.successfullyCancels) {
                test("emits log indicating successful fill", async () => {
                    const debtOrderDataWrapped = new DebtOrderDataWrapper(debtOrderData);

                    const txHash = await this.orderApi.cancelIssuanceAsync(
                        debtOrderDataWrapped.getIssuanceCommitment(),
                        { from: scenario.canceller },
                    );
                    const receipt = await this.web3Utils.getTransactionReceiptAsync(txHash);

                    const [debtIssuanceCancelledLog] = compact(ABIDecoder.decodeLogs(receipt.logs));

                    expect(debtIssuanceCancelledLog.name).toBe("LogIssuanceCancelled");
                });
            } else {
                test(`throws ${scenario.errorType} error`, async () => {
                    const debtOrderDataWrapped = new DebtOrderDataWrapper(debtOrderData);

                    await expect(
                        this.orderApi.cancelIssuanceAsync(
                            debtOrderDataWrapped.getIssuanceCommitment(),
                            { from: scenario.canceller },
                        ),
                    ).rejects.toThrow(scenario.errorMessage);
                });
            }
        });
    }

    public testOrderGenerationScenario(scenario: OrderGenerationScenario) {
        describe(scenario.description, () => {
            let adapter: Adapter;

            beforeEach(() => {
                adapter = scenario.adapter(this.adaptersApi);
            });

            if (!scenario.throws) {
                test("returns order translated by adapter from input parameters", async () => {
                    const expectedDebtOrderData = await adapter.toDebtOrder(
                        scenario.inputParameters,
                    );

                    await expect(
                        this.orderApi.generate(adapter, scenario.inputParameters),
                    ).resolves.toEqual(expectedDebtOrderData);
                });
            } else {
                test(`should throw ${scenario.errorType}`, async () => {
                    await expect(
                        this.orderApi.generate(adapter, scenario.inputParameters),
                    ).rejects.toThrow(scenario.errorMessage);
                });
            }
        });
    }

    public testUnpackTermsScenario(scenario: UnpackTermsScenario) {
        describe(scenario.description, () => {
            let debtOrderData: DebtOrderData;

            beforeEach(async () => {
                const simpleInterestTermsContract = this.termsContract;
                const collateralizedSimpleInterestTermsContract = await this.contractsApi.loadCollateralizedSimpleInterestTermsContract();
                const otherTermsContractAddress = ACCOUNTS[4].address;

                debtOrderData = {
                    kernelVersion: this.debtKernel.address,
                    issuanceVersion: this.repaymentRouter.address,
                    principalAmount: Units.ether(1),
                    principalToken: this.principalToken.address,
                    debtor: ACCOUNTS[1].address,
                    debtorFee: Units.ether(0.001),
                    creditor: ACCOUNTS[2].address,
                    creditorFee: Units.ether(0.001),
                    relayer: ACCOUNTS[3].address,
                    relayerFee: Units.ether(0.002),
                    termsContract: scenario.termsContract(
                        simpleInterestTermsContract.address,
                        collateralizedSimpleInterestTermsContract.address,
                        otherTermsContractAddress,
                    ),
                    termsContractParameters: scenario.termsContractParameters,
                    expirationTimestampInSec: new BigNumber(
                        moment()
                            .add(7, "days")
                            .unix(),
                    ),
                    salt: new BigNumber(0),
                };
            });

            if (!scenario.throws) {
                test("returns correctly unpacked parameters", async () => {
                    await expect(this.orderApi.unpackTerms(debtOrderData)).resolves.toEqual(
                        scenario.expectedParameters,
                    );
                });
            } else {
                test(`throws ${scenario.errorType}`, async () => {
                    await expect(this.orderApi.unpackTerms(debtOrderData)).rejects.toThrow(
                        scenario.errorMessage,
                    );
                });
            }
        });
    }

    public async saveSnapshotAsync() {
        this.currentSnapshotId = await this.web3Utils.saveTestSnapshot();
    }

    public async revertToSavedSnapshot() {
        await this.web3Utils.revertToSnapshot(this.currentSnapshotId);
    }

    private async setUpFillScenario(scenario: FillScenario): Promise<DebtOrderData> {
        let debtOrderData;

        if (scenario.isCollateralized) {
            const collateralizedTC = await this.contractsApi.loadCollateralizedSimpleInterestTermsContract();

            debtOrderData = scenario.generateDebtOrderData(
                this.debtKernel,
                this.repaymentRouter,
                this.principalToken,
                collateralizedTC,
            );

            /*
                Set up balances and allowances for collateral.
             */
            const dummyTokenRegistry = await TokenRegistryContract.deployed(this.web3, TX_DEFAULTS);

            const collateralTokenAddress = await dummyTokenRegistry.getTokenAddressByIndex.callAsync(
                scenario.collateralTokenIndex,
            );

            const collateralToken = await DummyTokenContract.at(
                collateralTokenAddress,
                this.web3,
                TX_DEFAULTS,
            );

            await collateralToken.setBalance.sendTransactionAsync(
                debtOrderData.debtor,
                new BigNumber(scenario.collateralBalance),
            );

            await collateralToken.approve.sendTransactionAsync(
                this.tokenTransferProxy.address,
                new BigNumber(scenario.collateralAllowance),
                { from: debtOrderData.debtor },
            );
        } else {
            debtOrderData = scenario.generateDebtOrderData(
                this.debtKernel,
                this.repaymentRouter,
                this.principalToken,
                this.termsContract,
            );
        }

        // We dynamically set the creditor's balance and
        // allowance of a given principal token to either
        // their assigned values in the fill scenario, or
        // to a default amount (i.e sufficient balance / allowance
        // necessary for order fill)
        const creditorBalance = scenario.creditorBalance || debtOrderData.principalAmount.times(2);
        const creditorAllowance =
            scenario.creditorAllowance || debtOrderData.principalAmount.times(2);

        await this.principalToken.setBalance.sendTransactionAsync(
            debtOrderData.creditor,
            creditorBalance,
        );
        await this.principalToken.approve.sendTransactionAsync(
            this.tokenTransferProxy.address,
            creditorAllowance,
            { from: debtOrderData.creditor },
        );

        // We dynamically attach signatures based on whether the
        // the scenario specifies that a signature from a signatory
        // ought to be attached.
        debtOrderData.debtorSignature = scenario.signatories.debtor
            ? await this.orderSigner.asDebtor(debtOrderData, false)
            : null;
        debtOrderData.creditorSignature = scenario.signatories.creditor
            ? await this.orderSigner.asCreditor(debtOrderData, false)
            : null;
        debtOrderData.underwriterSignature = scenario.signatories.underwriter
            ? await this.orderSigner.asUnderwriter(debtOrderData, false)
            : null;

        if (scenario.beforeBlock) {
            await scenario.beforeBlock(debtOrderData, this.debtKernel);
        }

        return debtOrderData;
    }
}
