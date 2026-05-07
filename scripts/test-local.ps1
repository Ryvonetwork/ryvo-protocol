param(
    [string]$TestPattern = "tests/**/*.ts",
    [string]$RpcUrl = "http://127.0.0.1:8899",
    [switch]$SkipPrepare
)

$RepoLinux = "/home/heis/ryvo/ryvo-protocol"
$RepoUnc = "\\wsl.localhost\Ubuntu\home\heis\ryvo\ryvo-protocol"
$WalletWindows = "\\wsl.localhost\Ubuntu\home\heis\ryvo\ryvo-protocol\keys\devnet-deployer.json"
$NodeExe = "C:\Program Files\nodejs\node.exe"
$PrepareScript = "./scripts/prepare-local-test-suite.sh"
$MochaScript = ".\node_modules\mocha\bin\mocha"
$RuntimeSetupScript = ".\scripts\test-runtime-setup.cjs"
$BootstrapTest = "tests/bootstrap-isolated.test.ts"
$DefaultPattern = "tests/**/*.ts"

function Invoke-PreparedValidator {
    wsl.exe -d Ubuntu bash -lc "cd '$RepoLinux' && $PrepareScript"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to prepare local validator and deploy the program."
    }
}

function Invoke-Mocha {
    param(
        [string[]]$MochaArgs
    )

    & $NodeExe --disable-warning=MODULE_TYPELESS_PACKAGE_JSON $MochaScript --require $RuntimeSetupScript --require ts-node/register --extension ts --timeout 1000000 @MochaArgs
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

if (-not $SkipPrepare) {
    Invoke-PreparedValidator
}

if (-not (Test-Path $NodeExe)) {
    throw "Node.exe not found at '$NodeExe'."
}

$env:ANCHOR_PROVIDER_URL = $RpcUrl
$env:ANCHOR_WALLET = $WalletWindows

Push-Location $RepoUnc
try {
    if (-not $SkipPrepare -and $TestPattern -eq $DefaultPattern) {
        Invoke-Mocha @($BootstrapTest)
        Invoke-PreparedValidator
        Invoke-Mocha @("--exclude", $BootstrapTest, $TestPattern)
    }
    else {
        Invoke-Mocha @($TestPattern)
    }
}
finally {
    Pop-Location
}
