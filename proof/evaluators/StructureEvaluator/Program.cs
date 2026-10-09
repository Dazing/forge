using System.Reflection;

if (args.Length != 1)
{
    Console.Error.WriteLine("Usage: StructureEvaluator <Inventory.Api.dll>");
    return 2;
}

var assembly = Assembly.LoadFrom(Path.GetFullPath(args[0]));
var store = assembly.GetType("ReservationStore");
if (store is null)
{
    Console.Error.WriteLine("FAIL: ReservationStore was not found.");
    return 1;
}

var transition = store.GetMethod("Transition", BindingFlags.Instance | BindingFlags.NonPublic);
if (transition is null || transition.ReturnType != typeof(bool))
{
    Console.Error.WriteLine("FAIL: one private shared Transition operation is required.");
    return 1;
}

var parameters = transition.GetParameters();
var reservationStatus = assembly.GetType("ReservationStatus");
if (
    parameters.Length != 3
    || parameters[0].ParameterType != typeof(Guid)
    || parameters[1].ParameterType != reservationStatus
    || parameters[2].ParameterType != typeof(bool)
)
{
    Console.Error.WriteLine(
        "FAIL: Transition must own reservation ID, destination state, and restock policy."
    );
    return 1;
}

Console.WriteLine(
    "PASS: transition eligibility and mutation are exposed through one private shared operation."
);
return 0;
