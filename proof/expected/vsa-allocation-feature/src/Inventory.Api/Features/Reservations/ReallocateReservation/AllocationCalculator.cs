namespace Inventory.Api.Features.Reservations.ReallocateReservation;

internal static class AllocationCalculator
{
    internal static AllocationDecision[]? Calculate(
        int requestedQuantity,
        IReadOnlyList<AllocationCandidate> routeOrderedCandidates
    )
    {
        if (requestedQuantity <= 0)
        {
            return null;
        }

        var remaining = requestedQuantity;
        var allocations = new List<AllocationDecision>();
        foreach (var candidate in routeOrderedCandidates)
        {
            var capacity = Math.Max(
                0L,
                (long)candidate.PhysicalAvailable
                    + candidate.CurrentReservationAllocation
                    - candidate.SafetyStock
            );
            var allocated = (int)Math.Min(remaining, capacity);
            if (allocated == 0)
            {
                continue;
            }

            allocations.Add(new AllocationDecision(candidate.Location, allocated));
            remaining -= allocated;
            if (remaining == 0)
            {
                return allocations.ToArray();
            }
        }

        return null;
    }
}

internal sealed record AllocationCandidate(
    string Location,
    int PhysicalAvailable,
    int SafetyStock,
    int CurrentReservationAllocation
);

internal sealed record AllocationDecision(string Location, int Quantity);
