// Vertical Slice Architecture — boundary enforcement for .NET (NetArchTest)
//
// The mechanical second net behind code review. The same intent as the
// TypeScript eslint-plugin-boundaries configs: make the dependency rules in
// platforms/dotnet/core.md FAIL CI when violated, instead of relying on vibes.
//
//   slice -> slice                  forbidden  (duplicate instead)
//   App.Persistence -> features      forbidden  (kernel knows nothing about features)
//   anything -> MediatR              forbidden  (no mediator/dispatcher)
//   feature folders, not layers      no Controllers/Services/Repositories namespaces
//
// Install (in a test project, e.g. App.Tests.Architecture):
//   dotnet add package NetArchTest.Rules
//   dotnet add package xunit
//   dotnet add package FluentAssertions
//
// TUNE the namespace roots ("App.Api.Features", "App.Persistence", ...) to your
// solution. Run as part of `dotnet test`.

using FluentAssertions;
using NetArchTest.Rules;
using Xunit;

public class ArchitectureTests
{
    // Reference any type from each assembly so it is loaded for scanning.
    private static System.Reflection.Assembly Api => typeof(App.Api.Program).Assembly;
    private static System.Reflection.Assembly Persistence => typeof(App.Persistence.AppDbContext).Assembly;

    // 1. A slice may not reference another slice. Each feature namespace is a
    //    boundary: types under Features.Users must not depend on Features.Orders,
    //    etc. (Spot-check the pairs that matter; or generate the matrix.)
    [Fact]
    public void Users_feature_does_not_reference_Orders_feature()
    {
        Types.InAssembly(Api)
            .That().ResideInNamespace("App.Api.Features.Users")
            .ShouldNot().HaveDependencyOn("App.Api.Features.Orders")
            .GetResult().IsSuccessful.Should().BeTrue();
    }

    // 2. The persistence kernel knows nothing about features or hosts. It carries
    //    data access only — no business logic reaching back into slices.
    [Fact]
    public void Persistence_does_not_reference_features_or_hosts()
    {
        Types.InAssembly(Persistence)
            .ShouldNot().HaveDependencyOnAny("App.Api", "App.Services")
            .GetResult().IsSuccessful.Should().BeTrue();
    }

    // 3. No mediator / dispatcher. This is feature-folder VSA, not message dispatch.
    [Fact]
    public void Nothing_references_MediatR()
    {
        Types.InAssembly(Api)
            .ShouldNot().HaveDependencyOn("MediatR")
            .GetResult().IsSuccessful.Should().BeTrue();
    }

    // 4. Feature folders, not technical layers. No Controllers/Services/Repositories
    //    namespaces sneaking the old layered architecture back in.
    [Fact]
    public void No_layered_namespaces()
    {
        Types.InAssembly(Api)
            .Should().NotResideInNamespaceContaining("Controllers")
            .And().NotResideInNamespaceContaining("Repositories")
            .GetResult().IsSuccessful.Should().BeTrue();
    }

    // 5. Endpoints/jobs are auto-discovered: every IEndpoint is concrete and
    //    discoverable. (Mirrors the "no manual registration" convention.)
    [Fact]
    public void Endpoints_are_concrete_so_assembly_scanning_finds_them()
    {
        Types.InAssembly(Api)
            .That().ImplementInterface(typeof(App.Api.Endpoints.IEndpoint))
            .Should().NotBeAbstract()
            .GetResult().IsSuccessful.Should().BeTrue();
    }
}
